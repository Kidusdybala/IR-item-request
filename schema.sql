-- Fresh database: wrangler d1 execute ir-item-request-db --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  telegram_id  INTEGER PRIMARY KEY,          -- permanent identity (usernames can change)
  username     TEXT,
  full_name    TEXT,
  employee_id  TEXT,
  status       TEXT NOT NULL DEFAULT 'new',  -- new | pending | approved | blocked
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  category      TEXT,
  unit          TEXT NOT NULL DEFAULT 'pcs',
  total_qty     INTEGER NOT NULL DEFAULT 0,
  available_qty INTEGER NOT NULL DEFAULT 0,  -- total minus reserved/out
  returnable    INTEGER NOT NULL DEFAULT 0,  -- 1 = must be returned (laptop), 0 = consumed (pens)
  loan_days     INTEGER NOT NULL DEFAULT 7,
  low_stock     INTEGER NOT NULL DEFAULT 2,
  active        INTEGER NOT NULL DEFAULT 1,  -- removed items are hidden, never deleted
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS requests (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                INTEGER NOT NULL REFERENCES users(telegram_id),
  username               TEXT,               -- snapshot at request time
  item_id                INTEGER NOT NULL REFERENCES items(id),
  item_name              TEXT NOT NULL,      -- snapshot
  qty                    INTEGER NOT NULL,
  status                 TEXT NOT NULL,      -- pending | approved | rejected | cancelled | received | return_pending | returned
  requested_at           TEXT NOT NULL,
  decided_at             TEXT,
  decided_by             INTEGER,
  received_at            TEXT,
  due_at                 TEXT,
  return_requested_at    TEXT,
  return_requested_qty   INTEGER NOT NULL DEFAULT 0,
  returned_qty           INTEGER NOT NULL DEFAULT 0,
  returned_at            TEXT,
  returned_confirmed_by  INTEGER,
  admin_note             TEXT,
  last_reminded_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_req_user   ON requests(user_id);
CREATE INDEX IF NOT EXISTS idx_req_item   ON requests(item_id);
CREATE INDEX IF NOT EXISTS idx_req_status ON requests(status);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  actor_id  INTEGER,
  action    TEXT NOT NULL,
  entity    TEXT,
  entity_id INTEGER,
  details   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (        -- tiny state store for text prompts
  telegram_id INTEGER PRIMARY KEY,
  state       TEXT NOT NULL
);
