ALTER TABLE accounts ADD COLUMN group_id TEXT;

UPDATE accounts SET group_id = id;

CREATE UNIQUE INDEX accounts_group_provider ON accounts(group_id, provider);

CREATE TRIGGER account_default_group AFTER INSERT ON accounts
WHEN NEW.group_id IS NULL BEGIN
  UPDATE accounts SET group_id = NEW.id WHERE id = NEW.id;
END;
