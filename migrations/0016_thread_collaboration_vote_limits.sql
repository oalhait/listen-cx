-- Replay receipts are permanent, but their cardinality must be bounded. These
-- triggers are the authoritative race-safe backstop; RAISE(IGNORE) leaves the
-- guarded vote mutation without a matching mutation token, so it cannot run.
CREATE TRIGGER thread_collaboration_vote_request_thread_limit
BEFORE INSERT ON thread_collaboration_vote_requests
WHEN (
  SELECT COUNT(*)
  FROM thread_collaboration_vote_requests request
  WHERE request.thread_id = NEW.thread_id
) >= 10000 BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER thread_collaboration_vote_request_participant_limit
BEFORE INSERT ON thread_collaboration_vote_requests
WHEN (
  SELECT COUNT(*)
  FROM thread_collaboration_vote_requests request
  WHERE request.participant_id = NEW.participant_id
) >= 1000 BEGIN
  SELECT RAISE(IGNORE);
END;
