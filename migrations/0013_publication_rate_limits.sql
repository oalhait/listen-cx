ALTER TABLE thread_publications ADD COLUMN rate_limit_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thread_subscriptions ADD COLUMN rate_limit_until INTEGER NOT NULL DEFAULT 0;

UPDATE thread_publications SET rate_limit_until = next_attempt_at WHERE failure_code = 'rate_limited';
UPDATE thread_subscriptions SET rate_limit_until = next_attempt_at WHERE failure_code = 'rate_limited';
