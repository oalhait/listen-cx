CREATE TABLE thread_collaboration_state (
  thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO thread_collaboration_state(thread_id)
SELECT id FROM threads;

CREATE TRIGGER thread_collaboration_state_on_thread_create
AFTER INSERT ON threads BEGIN
  INSERT INTO thread_collaboration_state(thread_id) VALUES (NEW.id);
END;

CREATE TABLE thread_collaboration_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  public_id TEXT NOT NULL UNIQUE
    CHECK (length(public_id) = 22 AND public_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  display_name TEXT NOT NULL
    CHECK (length(trim(display_name)) BETWEEN 1 AND 40),
  anonymous_digest TEXT,
  account_id TEXT REFERENCES accounts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (anonymous_digest IS NOT NULL AND account_id IS NULL)
    OR (anonymous_digest IS NULL AND account_id IS NOT NULL)
  ),
  CHECK (
    anonymous_digest IS NULL
    OR (length(anonymous_digest) = 64 AND anonymous_digest NOT GLOB '*[^0-9a-f]*')
  ),
  UNIQUE (thread_id, anonymous_digest),
  UNIQUE (thread_id, account_id),
  UNIQUE (id, thread_id)
);

CREATE INDEX thread_collaboration_participants_thread
  ON thread_collaboration_participants(thread_id, id);

CREATE UNIQUE INDEX thread_contributions_id_thread
  ON thread_contributions(id, thread_id);

CREATE TABLE thread_collaboration_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL,
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (participant_id, request_key),
  FOREIGN KEY (participant_id, thread_id)
    REFERENCES thread_collaboration_participants(id, thread_id) ON DELETE CASCADE
);

CREATE INDEX thread_collaboration_messages_thread
  ON thread_collaboration_messages(thread_id, id);

CREATE TABLE thread_collaboration_votes (
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  contribution_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('up', 'down')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (participant_id, contribution_id),
  FOREIGN KEY (participant_id, thread_id)
    REFERENCES thread_collaboration_participants(id, thread_id) ON DELETE CASCADE,
  FOREIGN KEY (contribution_id, thread_id)
    REFERENCES thread_contributions(id, thread_id) ON DELETE CASCADE
);

CREATE INDEX thread_collaboration_votes_contribution
  ON thread_collaboration_votes(thread_id, contribution_id);

CREATE TABLE thread_collaboration_vote_requests (
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL,
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  contribution_id INTEGER NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('up', 'down', 'clear')),
  mutation_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (participant_id, request_key),
  FOREIGN KEY (participant_id, thread_id)
    REFERENCES thread_collaboration_participants(id, thread_id) ON DELETE CASCADE,
  FOREIGN KEY (contribution_id, thread_id)
    REFERENCES thread_contributions(id, thread_id) ON DELETE CASCADE
);

CREATE INDEX thread_collaboration_vote_requests_thread
  ON thread_collaboration_vote_requests(thread_id, created_at);

CREATE TRIGGER thread_collaboration_participant_insert
AFTER INSERT ON thread_collaboration_participants BEGIN
  UPDATE thread_collaboration_state
  SET revision = revision + 1, updated_at = datetime('now')
  WHERE thread_id = NEW.thread_id;
END;

CREATE TRIGGER thread_collaboration_participant_rename
AFTER UPDATE OF display_name ON thread_collaboration_participants
WHEN NEW.display_name != OLD.display_name BEGIN
  UPDATE thread_collaboration_state
  SET revision = revision + 1, updated_at = datetime('now')
  WHERE thread_id = NEW.thread_id;
END;

CREATE TRIGGER thread_collaboration_message_insert
AFTER INSERT ON thread_collaboration_messages BEGIN
  UPDATE thread_collaboration_state
  SET revision = revision + 1, updated_at = datetime('now')
  WHERE thread_id = NEW.thread_id;
END;

CREATE TRIGGER thread_collaboration_message_delete
AFTER UPDATE OF deleted_at ON thread_collaboration_messages
WHEN NEW.deleted_at IS NOT OLD.deleted_at BEGIN
  UPDATE thread_collaboration_state
  SET revision = revision + 1, updated_at = datetime('now')
  WHERE thread_id = NEW.thread_id;
END;

CREATE TRIGGER thread_collaboration_vote_insert
AFTER INSERT ON thread_collaboration_votes BEGIN
  UPDATE thread_collaboration_state
  SET revision = revision + 1, updated_at = datetime('now')
  WHERE thread_id = NEW.thread_id;
END;

CREATE TRIGGER thread_collaboration_vote_update
AFTER UPDATE OF vote ON thread_collaboration_votes
WHEN NEW.vote != OLD.vote BEGIN
  UPDATE thread_collaboration_state
  SET revision = revision + 1, updated_at = datetime('now')
  WHERE thread_id = NEW.thread_id;
END;

CREATE TRIGGER thread_collaboration_vote_delete
AFTER DELETE ON thread_collaboration_votes BEGIN
  UPDATE thread_collaboration_state
  SET revision = revision + 1, updated_at = datetime('now')
  WHERE thread_id = OLD.thread_id;
END;
