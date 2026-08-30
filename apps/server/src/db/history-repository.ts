import {
  type GuildId,
  GuildIdSchema,
  type HistoryItem,
  HistoryItemSchema,
} from "@discord-music/contracts"
import type Database from "better-sqlite3"
import { z } from "zod"

const historyRowSchema = z.object({ payload_json: z.string() })
const historyLimit = 200

export class HistoryRepository {
  constructor(private readonly database: Database.Database) {}

  append(guildId: GuildId, item: HistoryItem): void {
    const parsedGuildId = GuildIdSchema.parse(guildId)
    const parsedItem = HistoryItemSchema.parse(item)
    this.database.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO history_items (guild_id, history_id, payload_json, played_at_ms)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (guild_id, history_id) DO UPDATE SET
            payload_json = excluded.payload_json,
            played_at_ms = excluded.played_at_ms
        `)
        .run(
          parsedGuildId,
          parsedItem.id,
          JSON.stringify(parsedItem),
          Date.parse(parsedItem.playedAt),
        )
      this.database
        .prepare(`
          DELETE FROM history_items
          WHERE guild_id = ? AND history_id NOT IN (
            SELECT history_id FROM history_items
            WHERE guild_id = ?
            ORDER BY played_at_ms DESC, history_id DESC
            LIMIT ?
          )
        `)
        .run(parsedGuildId, parsedGuildId, historyLimit)
    })()
  }

  list(guildId: GuildId): readonly HistoryItem[] {
    return this.database
      .prepare(`
        SELECT payload_json FROM history_items
        WHERE guild_id = ?
        ORDER BY played_at_ms DESC, history_id DESC
        LIMIT ?
      `)
      .all(GuildIdSchema.parse(guildId), historyLimit)
      .map((raw) => HistoryItemSchema.parse(JSON.parse(historyRowSchema.parse(raw).payload_json)))
  }
}
