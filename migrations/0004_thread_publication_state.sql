ALTER TABLE threads ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE threads ADD COLUMN mutation_token TEXT;
ALTER TABLE thread_contributions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thread_contributions ADD COLUMN source_verified INTEGER NOT NULL DEFAULT 0 CHECK (source_verified IN (0, 1));
UPDATE thread_contributions SET sort_order = position;

CREATE TABLE thread_creations (
  request_digest TEXT PRIMARY KEY,
  thread_id INTEGER NOT NULL UNIQUE REFERENCES threads(id)
);

CREATE TABLE thread_mutations (
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (thread_id, request_key)
);

CREATE TABLE thread_publications (
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  provider TEXT NOT NULL CHECK (provider IN ('spotify', 'apple')),
  requested_revision INTEGER NOT NULL CHECK (requested_revision >= 0),
  applied_revision INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'blocked', 'failed', 'synced')),
  blocked_reason TEXT,
  failure_code TEXT,
  verified_playlist_id TEXT,
  PRIMARY KEY (thread_id, provider),
  CHECK (applied_revision IS NULL OR (applied_revision >= 0 AND applied_revision <= requested_revision)),
  CHECK (applied_revision IS NULL OR verified_playlist_id IS NOT NULL),
  CHECK (status != 'synced' OR (applied_revision IS NOT NULL AND applied_revision = requested_revision AND verified_playlist_id IS NOT NULL)),
  CHECK (status != 'blocked' OR blocked_reason IS NOT NULL)
);

INSERT INTO thread_publications(thread_id, provider, requested_revision, status, blocked_reason)
SELECT id, 'spotify', revision, 'blocked', 'publisher_not_authorized' FROM threads;
INSERT INTO thread_publications(thread_id, provider, requested_revision, status, blocked_reason)
SELECT id, 'apple', revision, 'blocked', 'apple_sync_unavailable' FROM threads;

CREATE TRIGGER thread_publications_on_create AFTER INSERT ON threads BEGIN
  INSERT INTO thread_publications(thread_id, provider, requested_revision, status, blocked_reason)
  VALUES (NEW.id, 'spotify', NEW.revision, 'blocked', 'publisher_not_authorized');
  INSERT INTO thread_publications(thread_id, provider, requested_revision, status, blocked_reason)
  VALUES (NEW.id, 'apple', NEW.revision, 'blocked', 'apple_sync_unavailable');
END;

CREATE TRIGGER thread_publications_on_revision AFTER UPDATE OF revision ON threads
WHEN NEW.revision > OLD.revision BEGIN
  UPDATE thread_publications SET requested_revision = NEW.revision,
    status = CASE WHEN blocked_reason IS NULL THEN 'pending' ELSE 'blocked' END,
    failure_code = NULL
  WHERE thread_id = NEW.id;
END;
