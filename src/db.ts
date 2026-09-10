import { customAlphabet } from "nanoid";
import type { Resolved } from "./resolve.js";

const nano = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 7);
const MAX_SLUG_ATTEMPTS = 3;

export interface LinkRow {
  slug: string;
  isrc: string | null;
  title: string;
  artist: string;
  artwork_url: string | null;
  spotify_url: string | null;
  apple_url: string | null;
  complete: number;
  created_at: string;
}

export interface LinkStore {
  get(slug: string): Promise<LinkRow | null>;
  upsert(resolved: Resolved): Promise<LinkRow>;
  isReady(): Promise<boolean>;
}

export class D1LinkStore implements LinkStore {
  constructor(private db: D1Database) {}

  async get(slug: string): Promise<LinkRow | null> {
    return this.db.prepare("SELECT * FROM links WHERE slug = ?").bind(slug).first<LinkRow>();
  }

  async upsert(resolved: Resolved): Promise<LinkRow> {
    const db = this.db.withSession("first-primary");
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
      const slug = nano();
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO links
             (slug, isrc, title, artist, artwork_url, spotify_url, apple_url, complete)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          slug,
          resolved.isrc,
          resolved.title,
          resolved.artist,
          resolved.artworkUrl,
          resolved.spotifyUrl,
          resolved.appleUrl,
          0,
        )
        .run();

      if (result.meta.changes === 1) {
        const row = await db.prepare("SELECT * FROM links WHERE slug = ?").bind(slug).first<LinkRow>();
        if (row) return row;
        throw new Error("inserted link could not be read");
      }
    }

    throw new Error("could not allocate a unique slug");
  }

  async isReady(): Promise<boolean> {
    const result = await this.db.prepare("SELECT 1 AS ready").first<{ ready: number }>();
    return result?.ready === 1;
  }
}
