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

CREATE TABLE apple_service_migration_backups (
  kind TEXT NOT NULL CHECK (kind IN ('publication', 'subscription')),
  publisher_key TEXT NOT NULL,
  account_id TEXT,
  thread_id INTEGER NOT NULL,
  connected INTEGER NOT NULL,
  requested_revision INTEGER NOT NULL,
  applied_revision INTEGER,
  status TEXT NOT NULL,
  blocked_reason TEXT,
  failure_code TEXT,
  verified_playlist_id TEXT,
  verified_playlist_url TEXT,
  next_attempt_at INTEGER NOT NULL,
  rate_limit_until INTEGER NOT NULL,
  PRIMARY KEY (kind, publisher_key)
);

INSERT INTO apple_service_migration_backups
SELECT 'publication', publication.publisher_key, NULL, publication.thread_id, publication.connected,
  publication.requested_revision, publication.applied_revision, publication.status, publication.blocked_reason,
  publication.failure_code, publication.verified_playlist_id, publication.verified_playlist_url,
  publication.next_attempt_at, publication.rate_limit_until
FROM thread_publications publication WHERE publication.provider = 'apple' AND EXISTS (
  SELECT 1 FROM thread_subscriptions subscription WHERE subscription.thread_id = publication.thread_id
    AND subscription.provider = 'apple' AND subscription.connected = 1
);

INSERT INTO apple_service_migration_backups
SELECT 'subscription', subscription.publisher_key, subscription.account_id, subscription.thread_id,
  subscription.connected, subscription.requested_revision, subscription.applied_revision, subscription.status,
  subscription.blocked_reason, subscription.failure_code, subscription.verified_playlist_id,
  subscription.verified_playlist_url, subscription.next_attempt_at, subscription.rate_limit_until
FROM thread_subscriptions subscription WHERE subscription.provider = 'apple' AND subscription.connected = 1;

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
  INSERT OR IGNORE INTO apple_service_migration_backups
  SELECT 'subscription', NEW.publisher_key, NEW.account_id, NEW.thread_id, NEW.connected,
    NEW.requested_revision, NEW.applied_revision, NEW.status, NEW.blocked_reason, NEW.failure_code,
    NEW.verified_playlist_id, NEW.verified_playlist_url, NEW.next_attempt_at, NEW.rate_limit_until;
  INSERT OR IGNORE INTO apple_service_migration_backups
  SELECT 'publication', publication.publisher_key, NULL, publication.thread_id, publication.connected,
    publication.requested_revision, publication.applied_revision, publication.status, publication.blocked_reason,
    publication.failure_code, publication.verified_playlist_id, publication.verified_playlist_url,
    publication.next_attempt_at, publication.rate_limit_until FROM thread_publications publication
    WHERE publication.thread_id = NEW.thread_id AND publication.provider = 'apple';
  UPDATE thread_subscriptions SET service_migration_pending = 1, connected = 0,
    status = 'blocked', blocked_reason = 'service_migration_pending', failure_code = NULL,
    next_attempt_at = 32503680000000 WHERE publisher_key = NEW.publisher_key;
  UPDATE thread_publications SET connected = 1, service_owned = 1, service_migration_pending = 1,
    service_replacement_pending = CASE WHEN verified_playlist_id IS NULL THEN 0 ELSE 1 END,
    status = 'blocked', blocked_reason = 'service_migration_pending', failure_code = NULL,
    next_attempt_at = 32503680000000 WHERE thread_id = NEW.thread_id AND provider = 'apple';
END;

CREATE TRIGGER thread_subscription_service_migration_reconnect_fence
AFTER UPDATE OF connected ON thread_subscriptions
WHEN NEW.provider = 'apple' AND OLD.connected = 0 AND NEW.connected = 1 AND EXISTS (
  SELECT 1 FROM provider_service_migrations WHERE provider = 'apple' AND status = 'pending'
) BEGIN
  INSERT OR IGNORE INTO apple_service_migration_backups
  SELECT 'subscription', NEW.publisher_key, NEW.account_id, NEW.thread_id, NEW.connected,
    NEW.requested_revision, NEW.applied_revision, NEW.status, NEW.blocked_reason, NEW.failure_code,
    NEW.verified_playlist_id, NEW.verified_playlist_url, NEW.next_attempt_at, NEW.rate_limit_until;
  INSERT OR IGNORE INTO apple_service_migration_backups
  SELECT 'publication', publication.publisher_key, NULL, publication.thread_id, publication.connected,
    publication.requested_revision, publication.applied_revision, publication.status, publication.blocked_reason,
    publication.failure_code, publication.verified_playlist_id, publication.verified_playlist_url,
    publication.next_attempt_at, publication.rate_limit_until FROM thread_publications publication
    WHERE publication.thread_id = NEW.thread_id AND publication.provider = 'apple';
  UPDATE thread_subscriptions SET service_migration_pending = 1, connected = 0,
    status = 'blocked', blocked_reason = 'service_migration_pending', failure_code = NULL,
    next_attempt_at = 32503680000000 WHERE publisher_key = NEW.publisher_key;
  UPDATE thread_publications SET connected = 1, service_owned = 1, service_migration_pending = 1,
    service_replacement_pending = CASE WHEN verified_playlist_id IS NULL THEN 0 ELSE 1 END,
    status = 'blocked', blocked_reason = 'service_migration_pending', failure_code = NULL,
    next_attempt_at = 32503680000000 WHERE thread_id = NEW.thread_id AND provider = 'apple';
END;
