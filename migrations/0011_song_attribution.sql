CREATE TABLE account_profiles (
  group_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Listener',
  avatar_url TEXT,
  customized INTEGER NOT NULL DEFAULT 0 CHECK (customized IN (0, 1)),
  seeded INTEGER NOT NULL DEFAULT 0 CHECK (seeded IN (0, 1)),
  seed_attempt_at INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO account_profiles(group_id) SELECT DISTINCT group_id FROM accounts;

CREATE TRIGGER account_profile_link AFTER UPDATE OF group_id ON accounts
WHEN NEW.group_id != OLD.group_id BEGIN
  INSERT OR IGNORE INTO account_profiles(group_id) VALUES (NEW.group_id);
  UPDATE account_profiles SET
    display_name = (SELECT display_name FROM account_profiles WHERE group_id = OLD.group_id),
    avatar_url = (SELECT avatar_url FROM account_profiles WHERE group_id = OLD.group_id),
    customized = (SELECT customized FROM account_profiles WHERE group_id = OLD.group_id),
    seeded = (SELECT seeded FROM account_profiles WHERE group_id = OLD.group_id),
    updated_at = datetime('now')
  WHERE group_id = NEW.group_id AND customized = 0
    AND EXISTS (SELECT 1 FROM account_profiles old WHERE old.group_id = OLD.group_id
      AND (old.customized = 1 OR (account_profiles.seeded = 0 AND old.seeded = 1)));
END;

ALTER TABLE thread_contributions ADD COLUMN added_by_account_id TEXT REFERENCES accounts(id);
CREATE INDEX thread_contributions_author ON thread_contributions(added_by_account_id);
CREATE TRIGGER contribution_author_immutable BEFORE UPDATE OF added_by_account_id ON thread_contributions
WHEN NEW.added_by_account_id IS NOT OLD.added_by_account_id BEGIN
  SELECT RAISE(ABORT, 'contribution author is immutable');
END;
