CREATE TABLE threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_capability TEXT NOT NULL UNIQUE,
  management_digest TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE thread_contributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  link_slug TEXT NOT NULL REFERENCES links(slug),
  request_key TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  source_provider TEXT NOT NULL CHECK (source_provider IN ('spotify', 'apple')),
  source_catalog_id TEXT NOT NULL,
  source_storefront TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position > 0),
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (thread_id, request_key),
  UNIQUE (thread_id, position)
);

CREATE INDEX idx_thread_contributions_active
  ON thread_contributions(thread_id, position) WHERE removed_at IS NULL;

CREATE INDEX idx_thread_contributions_link_slug
  ON thread_contributions(link_slug);
