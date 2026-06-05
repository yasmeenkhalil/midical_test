import fs from "fs";
import { PDFParse } from "pdf-parse";

const PDF_FILE_PATH = "C:\\Users\\hp\\Downloads\\ContemporaryOralandMaxillofacialSurgery5thEd_260529_203157.pdf";
const BOOK_TITLE = "Contemporary Oraland Maxillofacial Surgery 5th Ed_260529_203157";
const SERVER_URL = "http://127.0.0.1:8787/api/upload-book";
const PROGRESS_FILE = "./upload_progress.json"; // ملف حفظ التقدم

// دالة لقراءة آخر chunk تم رفعه
function getLastUploadedChunk() {
  if (fs.existsSync(PROGRESS_FILE)) {
    const data = fs.readFileSync(PROGRESS_FILE, "utf-8");
    return JSON.parse(data).lastChunk || 0;
  }
  return 0;
}

// دالة لحفظ التقدم الحالي
function saveProgress(chunkIndex) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastChunk: chunkIndex }), "utf-8");
}

async function processAndSeedPDF() {
  console.log("⏳ Starting PDF extraction...");

  try {
    if (!fs.existsSync(PDF_FILE_PATH)) {
      console.error(`❌ File not found: ${PDF_FILE_PATH}`);
      return;
    }

    const dataBuffer = fs.readFileSync(PDF_FILE_PATH);
    const parser = new PDFParse({ data: dataBuffer });
    const pdfData = await parser.getText();
    await parser.destroy();

    const fullText = pdfData.text || "";
    console.log("✅ PDF extracted successfully");
    console.log(`📄 Characters: ${fullText.length}`);

    const chunkSize = 3000;
    let index = 0;
    
    // جلب نقطة التوقف السابقة إن وجدت
    const lastUploaded = getLastUploadedChunk();
    if (lastUploaded > 0) {
      console.log(`🔄 Resuming from chunk ${lastUploaded + 1}...`);
    }

    for (let i = 0; i < fullText.length; i += chunkSize) {
      index++;

      // تخطي الـ chunks التي تم رفعها سابقاً بنجاح
      if (index <= lastUploaded) {
        continue;
      }

      const chunkText = fullText.slice(i, i + chunkSize);
      console.log(`🚀 Uploading chunk ${index} of ${Math.ceil(fullText.length / chunkSize)}`);

      let success = false;
      let attempts = 0;
      const maxAttempts = 3; // محاولات إعادة الاتصال التلقائي قبل التوقف تماماً

      while (!success && attempts < maxAttempts) {
        try {
          attempts++;
          const response = await fetch(SERVER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bookTitle: `${BOOK_TITLE} - Part ${index}`,
              textContent: chunkText,
            }),
          });

          const result = await response.json();

          if (result.success) {
            console.log(`✅ Chunk ${index} uploaded`);
            saveProgress(index); // حفظ التقدم في الملف بعد كل رفع ناجح
            success = true;
          } else {
            console.error(`❌ Chunk ${index} failed:`, result.error);
            break; // مشكلة من الخادم نفسه، لا داعي لإعادة المحاولة فوراً
          }
        } catch (uploadError) {
          console.error(`❌ Upload error on chunk ${index} (Attempt ${attempts}/${maxAttempts}):`);
          
          if (attempts < maxAttempts) {
            console.log("⏳ Waiting 5 seconds before retrying...");
            await new Promise((resolve) => setTimeout(resolve, 5000)); // انتظر 5 ثوانٍ قبل المحاولة مجدداً
          } else {
            console.error("🛑 Internet disconnected or server down. Run the script again later to resume.");
            return; // إنهاء السكريبت مؤقتاً لحين عودة النت وتشغيله يدوياً
          }
        }
      }
    }

    console.log("🎉 Finished uploading all chunks!");
    
    // حذف ملف التقدم بعد الانتهاء الكامل بنجاح
    if (fs.existsSync(PROGRESS_FILE)) {
      fs.unlinkSync(PROGRESS_FILE);
    }

  } catch (error) {
    console.error("❌ Critical Error:", error);
  }
}

processAndSeedPDF();
