import type Database from "better-sqlite3"
import { z } from "zod"

const migrationRowSchema = z.object({ version: z.number().int().positive() })

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE guild_settings (
        guild_id TEXT PRIMARY KEY NOT NULL,
        volume INTEGER NOT NULL CHECK (volume BETWEEN 0 AND 200),
        loop_mode TEXT NOT NULL CHECK (loop_mode IN ('off', 'track', 'queue')),
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE history_items (
        guild_id TEXT NOT NULL,
        history_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        played_at_ms INTEGER NOT NULL,
        PRIMARY KEY (guild_id, history_id)
      );
      CREATE INDEX history_items_latest
        ON history_items (guild_id, played_at_ms DESC, history_id DESC);

      CREATE TABLE oauth_exchange_codes (
        token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
        user_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX oauth_exchange_codes_expiry ON oauth_exchange_codes (expires_at_ms);

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
        user_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER
      );
      CREATE INDEX sessions_expiry ON sessions (expires_at_ms);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE guild_settings_next (
        guild_id TEXT PRIMARY KEY NOT NULL,
        volume INTEGER NOT NULL CHECK (volume BETWEEN 0 AND 200),
        loop_mode TEXT NOT NULL CHECK (loop_mode IN ('off', 'track', 'queue')),
        updated_at_ms INTEGER NOT NULL
      );
      INSERT INTO guild_settings_next (guild_id, volume, loop_mode, updated_at_ms)
        SELECT guild_id, volume, loop_mode, updated_at_ms FROM guild_settings;
      DROP TABLE guild_settings;
      ALTER TABLE guild_settings_next RENAME TO guild_settings;
    `,
  },
] as const

export function migrate(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at_ms INTEGER NOT NULL
      )
    `)
    const applied = new Set(
      database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => migrationRowSchema.parse(row).version),
    )
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue
      database.exec(migration.sql)
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)")
        .run(migration.version, Date.now())
    }
  })()
}
