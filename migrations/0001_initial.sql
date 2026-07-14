CREATE TABLE links (
  slug TEXT PRIMARY KEY,
  isrc TEXT,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  artwork_url TEXT,
  spotify_url TEXT,
  apple_url TEXT,
  complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_links_isrc
  ON links(isrc) WHERE isrc IS NOT NULL AND complete = 1;
