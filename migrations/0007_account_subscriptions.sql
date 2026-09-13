CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('spotify', 'apple')),
  provider_subject TEXT NOT NULL,
  label TEXT NOT NULL,
  encrypted_credentials TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_subject),
  UNIQUE (id, provider)
);

CREATE TRIGGER account_identity_immutable BEFORE UPDATE OF id, provider, provider_subject ON accounts
WHEN NEW.id != OLD.id OR NEW.provider != OLD.provider OR NEW.provider_subject != OLD.provider_subject BEGIN
  SELECT RAISE(ABORT, 'account identity is immutable');
END;

CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX account_sessions_expiry ON account_sessions(expires_at);

CREATE TABLE account_oauth (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX account_oauth_expiry ON account_oauth(expires_at);

CREATE TABLE thread_subscriptions (
  account_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  provider TEXT NOT NULL CHECK (provider IN ('spotify', 'apple')),
  publisher_key TEXT NOT NULL UNIQUE,
  connected INTEGER NOT NULL DEFAULT 1 CHECK (connected IN (0, 1)),
  requested_revision INTEGER NOT NULL CHECK (requested_revision >= 0),
  applied_revision INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'blocked', 'failed', 'synced')),
  verified_playlist_id TEXT,
  verified_playlist_url TEXT,
  failure_code TEXT,
  blocked_reason TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, thread_id),
  FOREIGN KEY (account_id, provider) REFERENCES accounts(id, provider),
  CHECK (applied_revision IS NULL OR (applied_revision >= 0 AND applied_revision <= requested_revision)),
  CHECK (applied_revision IS NULL OR verified_playlist_id IS NOT NULL),
  CHECK (status != 'synced' OR (applied_revision IS NOT NULL AND applied_revision = requested_revision AND verified_playlist_id IS NOT NULL)),
  CHECK (status != 'blocked' OR blocked_reason IS NOT NULL)
);
CREATE INDEX thread_subscriptions_due ON thread_subscriptions(connected, status, next_attempt_at);
CREATE INDEX thread_subscriptions_thread ON thread_subscriptions(thread_id);

CREATE TRIGGER thread_subscription_identity_immutable
BEFORE UPDATE OF account_id, thread_id, provider, publisher_key ON thread_subscriptions
WHEN NEW.account_id != OLD.account_id OR NEW.thread_id != OLD.thread_id
  OR NEW.provider != OLD.provider OR NEW.publisher_key != OLD.publisher_key BEGIN
  SELECT RAISE(ABORT, 'subscription identity is immutable');
END;

CREATE TRIGGER thread_subscriptions_on_revision AFTER UPDATE OF revision ON threads
WHEN NEW.revision > OLD.revision BEGIN
  UPDATE thread_subscriptions SET requested_revision = NEW.revision, status = 'pending',
    blocked_reason = NULL, failure_code = NULL, next_attempt_at = 0, updated_at = datetime('now')
  WHERE thread_id = NEW.id AND connected = 1;
END;
