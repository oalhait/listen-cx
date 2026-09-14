ALTER TABLE thread_publications ADD COLUMN service_owned INTEGER NOT NULL DEFAULT 0 CHECK (service_owned IN (0, 1));
ALTER TABLE thread_publications ADD COLUMN edit_locked INTEGER NOT NULL DEFAULT 0 CHECK (edit_locked IN (0, 1));
ALTER TABLE thread_publications ADD COLUMN service_migration_pending INTEGER NOT NULL DEFAULT 0 CHECK (service_migration_pending IN (0, 1));
ALTER TABLE thread_publications ADD COLUMN service_replacement_pending INTEGER NOT NULL DEFAULT 0 CHECK (service_replacement_pending IN (0, 1));
ALTER TABLE thread_subscriptions ADD COLUMN service_migration_pending INTEGER NOT NULL DEFAULT 0 CHECK (service_migration_pending IN (0, 1));

CREATE TABLE provider_service_migrations (
  provider TEXT PRIMARY KEY CHECK (provider IN ('apple')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active'))
);
INSERT INTO provider_service_migrations(provider, status) VALUES ('apple', 'pending');

UPDATE thread_publications SET edit_locked = 1 WHERE provider = 'apple' AND connected = 1;

UPDATE thread_publications SET connected = 1, service_owned = 1, service_migration_pending = 1,
  service_replacement_pending = CASE WHEN verified_playlist_id IS NULL THEN 0 ELSE 1 END,
  status = 'blocked', blocked_reason = 'service_migration_pending', failure_code = NULL,
  next_attempt_at = 32503680000000
WHERE provider = 'apple' AND EXISTS (
  SELECT 1 FROM thread_subscriptions subscription
  WHERE subscription.thread_id = thread_publications.thread_id
    AND subscription.provider = 'apple' AND subscription.connected = 1
);

UPDATE thread_subscriptions SET service_migration_pending = 1, status = 'blocked',
  blocked_reason = 'service_migration_pending', failure_code = NULL, next_attempt_at = 32503680000000
WHERE provider = 'apple' AND connected = 1;

CREATE TRIGGER thread_publication_service_migration_fence
BEFORE UPDATE ON thread_publications
WHEN OLD.service_migration_pending = 1 AND NEW.service_migration_pending = 1 BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER thread_subscription_service_migration_fence
BEFORE UPDATE ON thread_subscriptions
WHEN OLD.service_migration_pending = 1 AND NEW.service_migration_pending = 1 BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER thread_subscription_service_migration_insert_fence
AFTER INSERT ON thread_subscriptions
WHEN NEW.provider = 'apple' AND EXISTS (
  SELECT 1 FROM provider_service_migrations WHERE provider = 'apple' AND status = 'pending'
) BEGIN
  UPDATE thread_subscriptions SET service_migration_pending = 1, connected = 0,
    status = 'blocked', blocked_reason = 'service_migration_pending', failure_code = NULL,
    next_attempt_at = 32503680000000 WHERE publisher_key = NEW.publisher_key;
END;
