CREATE TABLE thread_identities (
  contribution_id INTEGER NOT NULL REFERENCES thread_contributions(id),
  provider TEXT NOT NULL CHECK (provider IN ('spotify', 'apple')),
  catalog_id TEXT NOT NULL CHECK (
    (provider = 'spotify' AND length(catalog_id) = 22 AND catalog_id NOT GLOB '*[^A-Za-z0-9]*') OR
    (provider = 'apple' AND length(catalog_id) > 0 AND catalog_id NOT GLOB '*[^0-9]*')
  ),
  storefront TEXT NOT NULL CHECK (length(storefront) = 2 AND storefront NOT GLOB '*[^a-z]*' AND (provider != 'spotify' OR storefront = 'us')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (contribution_id, provider)
);

CREATE TRIGGER thread_identity_validate BEFORE INSERT ON thread_identities
WHEN NOT EXISTS (
  SELECT 1 FROM thread_contributions
  WHERE id = NEW.contribution_id AND removed_at IS NULL AND source_verified = 1 AND source_provider != NEW.provider
) BEGIN
  SELECT RAISE(ABORT, 'counterpart requires an active verified opposite-provider source');
END;

CREATE TRIGGER thread_identity_no_update BEFORE UPDATE ON thread_identities BEGIN
  SELECT RAISE(ABORT, 'confirmed counterpart is immutable');
END;

CREATE TRIGGER thread_identity_no_delete BEFORE DELETE ON thread_identities BEGIN
  SELECT RAISE(ABORT, 'confirmed counterpart is immutable');
END;

CREATE TRIGGER thread_identity_source_immutable
BEFORE UPDATE OF source_provider, source_catalog_id, source_storefront, source_verified ON thread_contributions
WHEN EXISTS (SELECT 1 FROM thread_identities WHERE contribution_id = OLD.id)
AND (NEW.source_provider != OLD.source_provider OR NEW.source_catalog_id != OLD.source_catalog_id
  OR NEW.source_storefront != OLD.source_storefront OR NEW.source_verified != OLD.source_verified) BEGIN
  SELECT RAISE(ABORT, 'confirmed counterpart source is immutable');
END;
