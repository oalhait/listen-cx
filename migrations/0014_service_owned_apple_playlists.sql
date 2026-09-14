UPDATE thread_publications SET connected = 1,
  status = CASE WHEN status = 'synced' AND applied_revision = requested_revision THEN status ELSE 'pending' END,
  blocked_reason = NULL, failure_code = NULL, next_attempt_at = 0
WHERE provider = 'apple' AND EXISTS (
  SELECT 1 FROM thread_subscriptions subscription
  WHERE subscription.thread_id = thread_publications.thread_id
    AND subscription.provider = 'apple' AND subscription.connected = 1
);

UPDATE thread_subscriptions SET status = 'pending', blocked_reason = NULL,
  failure_code = NULL, next_attempt_at = 0
WHERE provider = 'apple' AND connected = 1;
