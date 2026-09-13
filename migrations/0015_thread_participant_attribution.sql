CREATE TRIGGER thread_collaboration_account_link
AFTER UPDATE OF group_id ON accounts
WHEN NEW.group_id IS NOT OLD.group_id BEGIN
  UPDATE thread_collaboration_state
  SET revision = revision + 1, updated_at = datetime('now')
  WHERE thread_id IN (
    SELECT thread_id FROM thread_collaboration_participants
    WHERE account_id = NEW.id
  );
END;

CREATE TRIGGER thread_collaboration_profile_avatar
AFTER UPDATE OF avatar_url ON account_profiles
WHEN NEW.avatar_url IS NOT OLD.avatar_url BEGIN
  UPDATE thread_collaboration_state
  SET revision = revision + 1, updated_at = datetime('now')
  WHERE thread_id IN (
    SELECT participant.thread_id
    FROM thread_collaboration_participants participant
    JOIN accounts account ON account.id = participant.account_id
    WHERE account.group_id = NEW.group_id
  );
END;

ALTER TABLE thread_contributions
  ADD COLUMN added_by_participant_public_id TEXT
  REFERENCES thread_collaboration_participants(public_id);

CREATE INDEX thread_contributions_participant_author
  ON thread_contributions(added_by_participant_public_id);

CREATE TRIGGER contribution_participant_validate_insert
BEFORE INSERT ON thread_contributions
WHEN NEW.added_by_participant_public_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'contribution cannot have two authors')
    WHERE NEW.added_by_account_id IS NOT NULL;
  SELECT RAISE(ABORT, 'contribution participant must belong to the thread')
    WHERE NOT EXISTS (
      SELECT 1 FROM thread_collaboration_participants participant
      WHERE participant.public_id = NEW.added_by_participant_public_id
        AND participant.thread_id = NEW.thread_id
    );
END;

CREATE TRIGGER contribution_participant_immutable
BEFORE UPDATE OF added_by_participant_public_id ON thread_contributions
WHEN NEW.added_by_participant_public_id IS NOT OLD.added_by_participant_public_id BEGIN
  SELECT RAISE(ABORT, 'contribution participant is immutable');
END;

CREATE TRIGGER contribution_participant_thread_validate
BEFORE UPDATE OF thread_id ON thread_contributions
WHEN NEW.added_by_participant_public_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM thread_collaboration_participants participant
    WHERE participant.public_id = NEW.added_by_participant_public_id
      AND participant.thread_id = NEW.thread_id
  ) BEGIN
  SELECT RAISE(ABORT, 'contribution participant must belong to the thread');
END;

CREATE TRIGGER attributed_participant_thread_immutable
BEFORE UPDATE OF thread_id ON thread_collaboration_participants
WHEN NEW.thread_id IS NOT OLD.thread_id
  AND EXISTS (
    SELECT 1 FROM thread_contributions contribution
    WHERE contribution.added_by_participant_public_id = OLD.public_id
  ) BEGIN
  SELECT RAISE(ABORT, 'attributed participant thread is immutable');
END;
