UPDATE provider_service_migrations SET status = 'active' WHERE provider = 'apple';

UPDATE thread_publications SET service_migration_pending = 0
WHERE provider = 'apple' AND EXISTS (
  SELECT 1 FROM apple_service_migration_backups backup
  WHERE backup.kind = 'publication' AND backup.publisher_key = thread_publications.publisher_key
);

UPDATE thread_subscriptions SET service_migration_pending = 0
WHERE provider = 'apple' AND EXISTS (
  SELECT 1 FROM apple_service_migration_backups backup
  WHERE backup.kind = 'subscription' AND backup.publisher_key = thread_subscriptions.publisher_key
);

UPDATE thread_publications AS publication SET
  connected = (SELECT connected FROM apple_service_migration_backups backup
    WHERE backup.kind = 'publication' AND backup.publisher_key = publication.publisher_key),
  requested_revision = (SELECT requested_revision FROM apple_service_migration_backups backup
    WHERE backup.kind = 'publication' AND backup.publisher_key = publication.publisher_key),
  applied_revision = (SELECT applied_revision FROM apple_service_migration_backups backup
    WHERE backup.kind = 'publication' AND backup.publisher_key = publication.publisher_key),
  status = (SELECT status FROM apple_service_migration_backups backup
    WHERE backup.kind = 'publication' AND backup.publisher_key = publication.publisher_key),
  blocked_reason = (SELECT blocked_reason FROM apple_service_migration_backups backup
    WHERE backup.kind = 'publication' AND backup.publisher_key = publication.publisher_key),
  failure_code = (SELECT failure_code FROM apple_service_migration_backups backup
    WHERE backup.kind = 'publication' AND backup.publisher_key = publication.publisher_key),
  verified_playlist_id = (SELECT verified_playlist_id FROM apple_service_migration_backups backup
    WHERE backup.kind = 'publication' AND backup.publisher_key = publication.publisher_key),
  verified_playlist_url = (SELECT verified_playlist_url FROM apple_service_migration_backups backup
    WHERE backup.kind = 'publication' AND backup.publisher_key = publication.publisher_key),
  next_attempt_at = (SELECT next_attempt_at FROM apple_service_migration_backups backup
    WHERE backup.kind = 'publication' AND backup.publisher_key = publication.publisher_key),
  rate_limit_until = (SELECT rate_limit_until FROM apple_service_migration_backups backup
    WHERE backup.kind = 'publication' AND backup.publisher_key = publication.publisher_key),
  service_owned = 0,
  service_replacement_pending = 0
WHERE provider = 'apple' AND EXISTS (
  SELECT 1 FROM apple_service_migration_backups backup
  WHERE backup.kind = 'publication' AND backup.publisher_key = publication.publisher_key
);

UPDATE thread_subscriptions AS subscription SET
  connected = (SELECT connected FROM apple_service_migration_backups backup
    WHERE backup.kind = 'subscription' AND backup.publisher_key = subscription.publisher_key),
  requested_revision = (SELECT requested_revision FROM apple_service_migration_backups backup
    WHERE backup.kind = 'subscription' AND backup.publisher_key = subscription.publisher_key),
  applied_revision = (SELECT applied_revision FROM apple_service_migration_backups backup
    WHERE backup.kind = 'subscription' AND backup.publisher_key = subscription.publisher_key),
  status = (SELECT status FROM apple_service_migration_backups backup
    WHERE backup.kind = 'subscription' AND backup.publisher_key = subscription.publisher_key),
  blocked_reason = (SELECT blocked_reason FROM apple_service_migration_backups backup
    WHERE backup.kind = 'subscription' AND backup.publisher_key = subscription.publisher_key),
  failure_code = (SELECT failure_code FROM apple_service_migration_backups backup
    WHERE backup.kind = 'subscription' AND backup.publisher_key = subscription.publisher_key),
  verified_playlist_id = (SELECT verified_playlist_id FROM apple_service_migration_backups backup
    WHERE backup.kind = 'subscription' AND backup.publisher_key = subscription.publisher_key),
  verified_playlist_url = (SELECT verified_playlist_url FROM apple_service_migration_backups backup
    WHERE backup.kind = 'subscription' AND backup.publisher_key = subscription.publisher_key),
  next_attempt_at = (SELECT next_attempt_at FROM apple_service_migration_backups backup
    WHERE backup.kind = 'subscription' AND backup.publisher_key = subscription.publisher_key),
  rate_limit_until = (SELECT rate_limit_until FROM apple_service_migration_backups backup
    WHERE backup.kind = 'subscription' AND backup.publisher_key = subscription.publisher_key)
WHERE provider = 'apple' AND EXISTS (
  SELECT 1 FROM apple_service_migration_backups backup
  WHERE backup.kind = 'subscription' AND backup.publisher_key = subscription.publisher_key
);

UPDATE thread_publications AS publication SET
  requested_revision = (SELECT revision FROM threads WHERE id = publication.thread_id),
  status = 'pending', blocked_reason = NULL, failure_code = NULL, next_attempt_at = 0
WHERE provider = 'apple' AND connected = 1
  AND requested_revision < (SELECT revision FROM threads WHERE id = publication.thread_id)
  AND EXISTS (SELECT 1 FROM apple_service_migration_backups backup
    WHERE backup.kind = 'publication' AND backup.publisher_key = publication.publisher_key);

UPDATE thread_subscriptions AS subscription SET
  requested_revision = (SELECT revision FROM threads WHERE id = subscription.thread_id),
  status = 'pending', blocked_reason = NULL, failure_code = NULL, next_attempt_at = 0
WHERE provider = 'apple' AND connected = 1
  AND requested_revision < (SELECT revision FROM threads WHERE id = subscription.thread_id)
  AND EXISTS (SELECT 1 FROM apple_service_migration_backups backup
    WHERE backup.kind = 'subscription' AND backup.publisher_key = subscription.publisher_key);
