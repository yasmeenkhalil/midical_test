/**
* OMSPrep + Atlas — Cloudflare Worker (backend)
* Handles: signup/login (sessions), 2-hour free preview, plans,
* PayTabs hosted payment + webhook, manual ZainCash activation (admin),
* serving the PROTECTED (paid) content only to entitled users,
* AND Integrated AI (Vectorize + Llama 3) for Medical Exam Generation.
*/

const PLANS = {
  "2m":  { months: 2,  price: 5000,  label: "شهرين"     },
  "3m":  { months: 3,  price: 10000, label: "ثلاثة أشهر" },
  "12m": { months: 12, price: 25000, label: "سنة كاملة"  },
};
const PREVIEW_MS = 2 * 60 * 60 * 1000; // 2-hour free full preview
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days (seconds, for KV)

const CORS = (origin) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Credentials": "true",
});


function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS(origin) },
  });
}

// ---------- crypto helpers (PBKDF2 password hashing) ----------
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return bytesToHex(salt) + ":" + bytesToHex(new Uint8Array(bits));
}
async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  const recomputed = await hashPassword(password, saltHex);
  return timingSafeEq(recomputed.split(":"), hashHex);
}
function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function bytesToHex(b){return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");}
function hexToBytes(h){const a=new Uint8Array(h.length/2);for(let i=0; i<a.length; i++)a[i]=parseInt(h.substr(i*2,2),16);return a;}
function uuid(){return crypto.randomUUID();}

// ---------- session helpers ----------
async function createSession(env, userId){
  const sid = uuid();
  await env.SESSIONS.put("s:"+sid, userId, { expirationTtl: SESSION_TTL });
  return sid;
}
async function getUserIdFromReq(env, req){
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if(!m) return null;
  return await env.SESSIONS.get("s:"+m[1]);
}

// ---------- entitlement ----------
async function getEntitlement(env, userId){
  const now = Date.now();
  const sub = await env.DB.prepare(
    "SELECT * FROM subscriptions WHERE user_id=?1 AND status='active' AND end_at>?2 ORDER BY end_at DESC LIMIT 1"
  ).bind(userId, now).first();
  if (sub) return { access: "full", until: sub.end_at, plan: sub.plan };

  const user = await env.DB.prepare("SELECT preview_used_at FROM users WHERE id=?1").bind(userId).first();
  if (user && user.preview_used_at) {
    const until = user.preview_used_at + PREVIEW_MS;
    if (now < until) return { access: "preview", until, plan: null };
  }
  return { access: "none", until: null, plan: null };
}

// ---------- PayTabs ----------
function paytabsBase(region){
  const map = {
    ARE: "https://paytabs.com",
    SAU: "https://paytabs.sa",
    EGY: "https://paytabs.com",
    JOR: "https://paytabs.com",
    OMN: "https://paytabs.com",
    KWT: "https://paytabs.com",
    GLOBAL: "https://paytabs.com",
  };
  return map[region] || map.GLOBAL;
}

async function paytabsCreatePage(env, { cartId, amount, currency, plan, user, siteUrl }){
  const base = paytabsBase(env.PAYTABS_REGION);
  const body = {
    profile_id: Number(env.PAYTABS_PROFILE_ID),
    tran_type: "sale",
    tran_class: "ecom",
    cart_id: cartId,
    cart_currency: currency,
    cart_amount: amount,
    cart_description: "OMSPrep+Atlas subscription: " + plan,
    paypage_lang: "ar",
    customer_details: { name: user.name || "Student", email: user.email },
    callback: siteUrl + "/api/pay/webhook",
    return: siteUrl + "/?pay=done&cart=" + cartId,
  };
  const res = await fetch(base + "/payment/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": env.PAYTABS_SERVER_KEY },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function paytabsQuery(env, tranRef){
  const base = paytabsBase(env.PAYTABS_REGION);
  const res = await fetch(base + "/payment/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": env.PAYTABS_SERVER_KEY },
    body: JSON.stringify({ profile_id: Number(env.PAYTABS_PROFILE_ID), tran_ref: tranRef }),
  });
  return await res.json();
}

async function activateSubscription(env, { userId, plan, source, amount, currency, ref }){
  const now = Date.now();
  const months = PLANS[plan].months;
  const end = now + months * 30 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    "INSERT INTO subscriptions (id,user_id,plan,source,status,start_at,end_at,amount,currency,ref,created_at) VALUES (?1,?2,?3,?4,'active',?5,?6,?7,?8,?9,?5)"
  ).bind(uuid(), userId, plan, source, now, end, amount||PLANS[plan].price, currency||"IQD", ref||"").run();
  return end;
}
// ---------- main fetch ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || env.SITE_URL || "*";
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS(origin) });

    try {
 
      // ---- SIGNUP ----
      if (url.pathname === "/api/signup" && req.method === "POST") {
        const { email, password, name } = await req.json();
        if (!email || !password || password.length < 6) return json({ error: "بريد/كلمة مرور غير صالحة (٦ أحرف على الأقل)" }, 400, origin);
        const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?1").bind(email.toLowerCase()).first();
        if (exists) return json({ error: "هذا البريد مسجَّل بالفعل" }, 409, origin);
        const id = uuid();
        const ph = await hashPassword(password);
        await env.DB.prepare("INSERT INTO users (id,email,pass_hash,name,created_at) VALUES (?1,?2,?3,?4,?5)")
          .bind(id, email.toLowerCase(), ph, name || "", Date.now()).run();
        const sid = await createSession(env, id);
        return json({ token: sid, email: email.toLowerCase(), name: name || "" }, 200, origin);
      }

      // ---- LOGIN ----
      if (url.pathname === "/api/login" && req.method === "POST") {
        const { email, password } = await req.json();
        const u = await env.DB.prepare("SELECT * FROM users WHERE email=?1").bind((email||"").toLowerCase()).first();
        if (!u || !(await verifyPassword(password, u.pass_hash))) return json({ error: "بيانات الدخول غير صحيحة" }, 401, origin);
        const sid = await createSession(env, u.id);
        return json({ token: sid, email: u.email, name: u.name }, 200, origin);
      }

      // ---- ME (status + entitlement) ----
      if (url.pathname === "/api/me" && req.method === "GET") {
        const userId = await getUserIdFromReq(env, req);
        if (!userId) return json({ error: "unauthorized" }, 401, origin);
        const u = await env.DB.prepare("SELECT email,name,preview_used_at FROM users WHERE id=?1").bind(userId).first();
        const ent = await getEntitlement(env, userId);
        return json({ email: u.email, name: u.name, entitlement: ent, previewUsed: !!u.preview_used_at }, 200, origin);
      }

      // ---- START 2-HOUR PREVIEW ----
      if (url.pathname === "/api/preview/start" && req.method === "POST") {
        const userId = await getUserIdFromReq(env, req);
        if (!userId) return json({ error: "unauthorized" }, 401, origin);
        const u = await env.DB.prepare("SELECT preview_used_at FROM users WHERE id=?1").bind(userId).first();
        if (u.preview_used_at) {
          const until = u.preview_used_at + PREVIEW_MS;
          if (Date.now() < until) return json({ ok: true, until }, 200, origin);
          return json({ error: "انتهت فترة المعاينة المجانية (ساعتان)" }, 403, origin);
        }
        const now = Date.now();
        await env.DB.prepare("UPDATE users SET preview_used_at=?1 WHERE id=?2").bind(now, userId).run();
        return json({ ok: true, until: now + PREVIEW_MS }, 200, origin);
      }

      // ---- PROTECTED CONTENT (the 60%) ----
      if (url.pathname === "/api/content" && req.method === "GET") {
        const userId = await getUserIdFromReq(env, req);
        if (!userId) return json({ error: "unauthorized" }, 401, origin);
        const ent = await getEntitlement(env, userId);
        if (ent.access === "none") return json({ error: "اشتراك مطلوب", entitlement: ent }, 402, origin);
        const paid = await env.PAID.get("PAID_CONTENT");
        if (!paid) return json({ error: "content unavailable" }, 503, origin);
        const u = await env.DB.prepare("SELECT email FROM users WHERE id=?1").bind(userId).first();
        return new Response(JSON.stringify({ entitlement: ent, watermark: u.email, content: JSON.parse(paid) }), {
          headers: { "Content-Type": "application/json; charset=utf-8", ...CORS(origin) },
        });
      }

      // ---- CREATE PAYMENT (PayTabs) ----
      if (url.pathname === "/api/pay/create" && req.method === "POST") {
        const userId = await getUserIdFromReq(env, req);
        if (!userId) return json({ error: "unauthorized" }, 401, origin);
        const { plan } = await req.json();
        if (!PLANS[plan]) return json({ error: "خطة غير صالحة" }, 400, origin);
        const u = await env.DB.prepare("SELECT email,name FROM users WHERE id=?1").bind(userId).first();
        const cartId = "OMS-" + Date.now() + "-" + userId.slice(0, 8);
        const currency = env.PAYTABS_CURRENCY || "IQD";
        const amount = PLANS[plan].price;
        await env.DB.prepare("INSERT INTO payments (id,user_id,plan,amount,currency,gateway,status,created_at) VALUES (?1,?2,?3,?4,?5,'paytabs','created',?6)")
          .bind(cartId, userId, plan, amount, currency, Date.now()).run();
        const pt = await paytabsCreatePage(env, { cartId, amount, currency, plan, user: u, siteUrl: env.SITE_URL });
        if (pt && pt.redirect_url) {
          await env.DB.prepare("UPDATE payments SET tran_ref=?1 WHERE id=?2").bind(pt.tran_ref || "", cartId).run();
          return json({ redirect_url: pt.redirect_url, cart: cartId }, 200, origin);
        }
        return json({ error: "تعذّر إنشاء صفحة الدفع", detail: pt }, 502, origin);
      }

      // ---- PAYTABS WEBHOOK (server-to-server) ----
      if (url.pathname === "/api/pay/webhook" && req.method === "POST") {
        const payload = await req.json().catch(() => ({}));
        const tranRef = payload.tran_ref;
        const cartId = payload.cart_id;
        if (!tranRef || !cartId) return json({ ok: false }, 400, origin);
        const q = await paytabsQuery(env, tranRef);
        const ok = q && q.payment_result && q.payment_result.response_status === "A";
        const pay = await env.DB.prepare("SELECT * FROM payments WHERE id=?1").bind(cartId).first();
        if (ok && pay && pay.status !== "paid") {
          await env.DB.prepare("UPDATE payments SET status='paid', tran_ref=?1 WHERE id=?2").bind(tranRef, cartId).run();
          await activateSubscription(env, { userId: pay.user_id, plan: pay.plan, source: "paytabs", amount: pay.amount, currency: pay.currency, ref: tranRef });
        } else if (pay && !ok) {
          await env.DB.prepare("UPDATE payments SET status='failed' WHERE id=?1").bind(cartId).run();
        }
        return json({ ok: true }, 200, origin);
      }

      // ---- ADMIN: manual ZainCash activation ----
      if (url.pathname === "/api/admin/activate" && req.method === "POST") {
        const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        if (token !== env.ADMIN_TOKEN) return json({ error: "forbidden" }, 403, origin);
        const { email, plan, note } = await req.json();
        if (!PLANS[plan]) return json({ error: "خطة غير صالحة" }, 400, origin);
        const u = await env.DB.prepare("SELECT id FROM users WHERE email=?1").bind((email||"").toLowerCase()).first();
        if (!u) return json({ error: "لا يوجد مستخدم بهذا البريد" }, 404, origin);
        const end = await activateSubscription(env, { userId: u.id, plan, source: "zaincash_manual", amount: PLANS[plan].price, currency: "IQD", ref: note || "ZainCash manual" });
        return json({ ok: true, email, plan, end_at: end }, 200, origin);
      }

      // ---- plans (public) ----
      if (url.pathname === "/api/plans") return json({ plans: PLANS, previewHours: 2 }, 200, origin);

      // =======================================================================
      // 🌟 ميزات الذكاء الاصطناعي الجديدة المدمجة بالكامل (AI Features) 🌟
      // =======================================================================

           // =======================================================================
      // 🌟 ميزات الذكاء الاصطناعي الجديدة المدمجة بالكامل (AI Features) 🌟
      // =======================================================================

           // 1. مسار رفع وتخزين نصوص المراجع والكتب الطبية في الكلاود (Vectorize)
 if (url.pathname === "/api/upload-book" && req.method === "POST") {
  const { bookTitle, textContent } = await req.json();

  if (!bookTitle || !textContent)
    return json({ error: "Missing required data" }, 400, origin);

  const chunkSize = 1200;

  const chunks = [];
  for (let i = 0; i < textContent.length; i += chunkSize) {
    chunks.push(textContent.slice(i, i + chunkSize));
  }

  console.log(`📦 Total chunks: ${chunks.length}`);

  for (let i = 0; i < chunks.length; i++) {
    const rawChunk = chunks[i];

    // 🔥 أهم تعديل: نخلي الـ AI يفهم السياق
    const enrichedText = `
Book Title: ${bookTitle}

Medical Text:
${rawChunk}
    `.trim();

    // 🔥 embedding
    const embeddingResponse = await env.AI.run(
      "@cf/baai/bge-base-en-v1.5",
      { text: [enrichedText] }
    );

    const vectors = embeddingResponse.data?.[0];

    if (!vectors) {
      console.log(`❌ Failed chunk ${i}`);
      continue;
    }

    // 🔥 Vectorize storage (مهم نحفظ الكتاب + النص + رقم الشنق)
    await env.VECTORIZE.upsert([
      {
        id: `${bookTitle}-chunk-${i}`,
        values: vectors,
        metadata: {
          bookTitle,
          text: rawChunk,
          chunk: i
        }
      }
    ]);

    console.log(`✅ Uploaded chunk ${i + 1}/${chunks.length}`);
  }

  return json(
    {
      success: true,
      message: "Book indexed successfully",
      chunks: chunks.length
    },
    200,
    origin
  );
}

       if (url.pathname === "/api/generate-questions" && req.method === "POST") {
  try {
    const { numberOfQuestions = 5, topic = "General" } = await req.json();

    // 🔥 تحويل التوبيك إلى embedding (مهم جداً)
    const embeddingResponse = await env.AI.run(
      '@cf/baai/bge-base-en-v1.5',
      { text: [topic] }
    );

    const queryVector = embeddingResponse.data[0];

    // 🔥 البحث الصحيح داخل Vectorize
    const vectorResults = await env.VECTORIZE.query(queryVector, {
      topK: 6,
      returnMetadata: true
    });

    const context = vectorResults.matches
      ?.map(m => m.metadata?.text)
      .filter(Boolean)
      .join("\n\n") || "";

    const bookTitle =
      "Contemporary Oraland Maxillofacial Surgery 5th Ed_260529_203157";

    const systemPrompt = `
You are an expert medical professor in Oral and Maxillofacial Surgery.

You MUST generate questions ONLY from the provided textbook content.

TEXTBOOK CONTENT:
${context}

Generate exactly ${numberOfQuestions} MCQ questions about ${topic}.

Return ONLY valid JSON:

{
  "questions":[
    {
      "question":"Question text",
      "options":["A","B","C","D"],
      "correct_answer":"A",
      "explanation":"Short explanation based ONLY on the provided text."
    }
  ]
}

Rules:
- Use ONLY the provided textbook content.
- Do not use external knowledge.
- Explanation must come from the text.
- No markdown or extra text.
`;

    const aiResponse = await env.AI.run(
      "@cf/meta/llama-3.2-3b-instruct",
      {
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: `Generate ${numberOfQuestions} MCQs about: ${topic}`
          }
        ],
        max_tokens: 1200,
        response_format: {
          type: "json_object"
        }
      }
    );

    console.log(
      "FULL AI RESPONSE:",
      JSON.stringify(aiResponse, null, 2)
    );

    let generatedQuestions = [];

    if (aiResponse?.response?.questions) {
      generatedQuestions = aiResponse.response.questions;
    } else if (aiResponse?.choices?.[0]?.message?.content) {
      const parsed = JSON.parse(aiResponse.choices[0].message.content);
      generatedQuestions = parsed.questions || [];
    } else if (aiResponse?.questions) {
      generatedQuestions = aiResponse.questions;
    } else if (typeof aiResponse === "string") {
      const parsed = JSON.parse(aiResponse);
      generatedQuestions = parsed.questions || [];
    }

    if (!Array.isArray(generatedQuestions) || generatedQuestions.length === 0) {
      throw new Error("AI returned no questions");
    }

    console.log(`💾 حفظ ${generatedQuestions.length} سؤال`);

    try {
      const stmt = env.DB.prepare(`
        INSERT INTO questions
        (book_title, question, options, correct_answer)
        VALUES (?, ?, ?, ?)
      `);

      for (const q of generatedQuestions) {
        await stmt
          .bind(
            bookTitle,
            q.question,
            JSON.stringify(q.options || []),
            q.correct_answer
          )
          .run();
      }

      console.log("✅ تم حفظ الأسئلة");
    } catch (dbError) {
      console.error("D1 ERROR:", dbError.message);
    }

    return new Response(
      JSON.stringify({
        success: true,
        count: generatedQuestions.length,
        data: generatedQuestions,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...CORS(origin),
        },
      }
    );

  } catch (error) {
    console.error("💥 AI ERROR:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...CORS(origin),
        },
      }
    );
  }
}






      // 3. مسار مراجعة إجابة الطالب الخاطئة وشرح السبب باللغة الإنجليزية
      if (url.pathname === "/api/review-answer" && req.method === "POST") {
        const { question, studentAnswer, correctAnswer } = await req.json();

        const prompt = `Question: "${question}".
        Correct answer: "${correctAnswer}".
        Student chose a wrong answer: "${studentAnswer}".
        
        Write a detailed, educational medical explanation in English explaining why the student's choice is incorrect and why the correct answer is right based on trusted medical textbooks without hallucination.`;

        const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { prompt });
        return json({ explanation: aiResponse }, 200, origin);
      }

     

      // return json({ error: "not found" }, 404, origin);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: "server error", detail: String(e) }, 500, origin);
    }
  }
};

