ALTER TABLE thread_publications ADD COLUMN service_owned INTEGER NOT NULL DEFAULT 0 CHECK (service_owned IN (0, 1));

UPDATE thread_publications SET connected = 1, service_owned = 1, status = 'pending',
  blocked_reason = NULL, failure_code = NULL,
  next_attempt_at = (unixepoch() * 1000) + 300000
WHERE provider = 'apple' AND EXISTS (
  SELECT 1 FROM thread_subscriptions subscription
  WHERE subscription.thread_id = thread_publications.thread_id
    AND subscription.provider = 'apple' AND subscription.connected = 1
);

UPDATE thread_subscriptions SET status = 'pending', blocked_reason = NULL,
  failure_code = NULL, next_attempt_at = 0
WHERE provider = 'apple' AND connected = 1;
