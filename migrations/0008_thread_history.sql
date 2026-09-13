CREATE TABLE thread_history (
  owner_key TEXT NOT NULL,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  account_id TEXT REFERENCES accounts(id),
  browser_digest TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_key, thread_id),
  CHECK ((account_id IS NOT NULL AND browser_digest IS NULL) OR (account_id IS NULL AND browser_digest IS NOT NULL))
);
CREATE INDEX thread_history_account ON thread_history(account_id, thread_id);
CREATE INDEX thread_history_browser ON thread_history(browser_digest, thread_id);
