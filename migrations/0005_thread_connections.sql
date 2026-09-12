ALTER TABLE thread_publications ADD COLUMN connected INTEGER NOT NULL DEFAULT 0 CHECK (connected IN (0, 1));
ALTER TABLE thread_publications ADD COLUMN verified_playlist_url TEXT;
ALTER TABLE thread_publications ADD COLUMN publisher_key TEXT;
ALTER TABLE thread_publications ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
UPDATE thread_publications SET publisher_key = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX thread_publisher_keys ON thread_publications(publisher_key);

CREATE TRIGGER thread_publisher_key_on_create AFTER INSERT ON thread_publications BEGIN
  UPDATE thread_publications SET publisher_key = lower(hex(randomblob(16)))
  WHERE thread_id = NEW.thread_id AND provider = NEW.provider;
END;

DROP TRIGGER thread_publications_on_revision;
CREATE TRIGGER thread_publications_on_revision AFTER UPDATE OF revision ON threads
WHEN NEW.revision > OLD.revision BEGIN
  UPDATE thread_publications SET requested_revision = NEW.revision,
    status = CASE WHEN connected = 1 THEN 'pending' ELSE 'blocked' END,
    blocked_reason = CASE WHEN connected = 1 THEN NULL ELSE blocked_reason END,
    failure_code = NULL, next_attempt_at = 0
  WHERE thread_id = NEW.id;
END;
