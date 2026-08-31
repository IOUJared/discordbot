import {
  type GuildId,
  GuildIdSchema,
  type LoopMode,
  LoopModeSchema,
  type Volume,
  VolumeSchema,
} from "@discord-music/contracts"
import type Database from "better-sqlite3"
import { z } from "zod"

import type { Clock } from "../domain/clock.js"

const settingsRowSchema = z.object({
  guild_id: GuildIdSchema,
  volume: VolumeSchema,
  loop_mode: LoopModeSchema,
})

export type GuildSettings = {
  readonly volume: Volume
  readonly loopMode: LoopMode
}

const defaultSettings: GuildSettings = {
  volume: VolumeSchema.parse(100),
  loopMode: "off",
}

export class SettingsRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock,
  ) {}

  get(guildId: GuildId): GuildSettings {
    const raw = this.database
      .prepare(`
        SELECT guild_id, volume, loop_mode
        FROM guild_settings
        WHERE guild_id = ?
      `)
      .get(guildId)
    if (raw === undefined) return defaultSettings
    const row = settingsRowSchema.parse(raw)
    return {
      volume: row.volume,
      loopMode: row.loop_mode,
    }
  }

  set(guildId: GuildId, settings: GuildSettings): void {
    const parsedGuildId = GuildIdSchema.parse(guildId)
    const parsedVolume = VolumeSchema.parse(settings.volume)
    const parsedLoopMode = LoopModeSchema.parse(settings.loopMode)
    this.database
      .prepare(`
        INSERT INTO guild_settings (
          guild_id, volume, loop_mode, updated_at_ms
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT (guild_id) DO UPDATE SET
          volume = excluded.volume,
          loop_mode = excluded.loop_mode,
          updated_at_ms = excluded.updated_at_ms
      `)
      .run(
        parsedGuildId,
        parsedVolume,
        parsedLoopMode,
        this.clock.now().getTime(),
      )
  }
}
