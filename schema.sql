-- schema.sql — Cloudflare D1 database for OMSPrep+Atlas
-- Run with: wrangler d1 execute omsprep-db --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,         -- uuid
  email         TEXT UNIQUE NOT NULL,
  pass_hash     TEXT NOT NULL,            -- PBKDF2 hash (salt:hash)
  name          TEXT,
  created_at    INTEGER NOT NULL,         -- epoch ms
  preview_used_at INTEGER                 -- when the 2-hour free preview was first started (epoch ms), null = never
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id          TEXT PRIMARY KEY,           -- uuid
  user_id     TEXT NOT NULL,
  plan        TEXT NOT NULL,              -- '2m' | '3m' | '12m'
  source      TEXT NOT NULL,              -- 'paytabs' | 'zaincash_manual'
  status      TEXT NOT NULL,              -- 'active' | 'pending' | 'expired'
  start_at    INTEGER NOT NULL,           -- epoch ms
  end_at      INTEGER NOT NULL,           -- epoch ms
  amount      INTEGER,                    -- paid amount
  currency    TEXT,
  ref         TEXT,                       -- payment reference (paytabs tran_ref or manual note)
  created_at  INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,           -- our cart_id / order id
  user_id     TEXT NOT NULL,
  plan        TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  currency    TEXT NOT NULL,
  gateway     TEXT NOT NULL,              -- 'paytabs'
  tran_ref    TEXT,                       -- filled from PayTabs
  status      TEXT NOT NULL,              -- 'created' | 'paid' | 'failed'
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_pay_user ON payments(user_id);
