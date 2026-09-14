ALTER TABLE thread_publications ADD COLUMN service_owned INTEGER NOT NULL DEFAULT 0 CHECK (service_owned IN (0, 1));
ALTER TABLE thread_publications ADD COLUMN edit_locked INTEGER NOT NULL DEFAULT 0 CHECK (edit_locked IN (0, 1));

UPDATE thread_publications SET edit_locked = 1 WHERE provider = 'apple' AND connected = 1;

UPDATE thread_publications SET connected = 0, service_owned = 1, status = 'blocked',
  blocked_reason = 'service_migration_pending', failure_code = NULL, next_attempt_at = 0
WHERE provider = 'apple' AND EXISTS (
  SELECT 1 FROM thread_subscriptions subscription
  WHERE subscription.thread_id = thread_publications.thread_id
    AND subscription.provider = 'apple' AND subscription.connected = 1
);

UPDATE thread_subscriptions SET status = 'blocked', blocked_reason = 'service_migration_pending',
  failure_code = NULL, next_attempt_at = 0
WHERE provider = 'apple' AND connected = 1;
