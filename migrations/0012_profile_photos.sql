CREATE TABLE profile_photos (
  group_id TEXT PRIMARY KEY REFERENCES account_profiles(group_id),
  id TEXT NOT NULL UNIQUE,
  bytes BLOB NOT NULL CHECK (length(bytes) > 0 AND length(bytes) <= 196608)
);
