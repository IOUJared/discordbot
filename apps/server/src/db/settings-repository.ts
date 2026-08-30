import {
  type GuildId,
  GuildIdSchema,
  type LoopMode,
  LoopModeSchema,
  type MediaSourcePreference,
  MediaSourcePreferenceSchema,
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
  source_preference: MediaSourcePreferenceSchema,
  mock_tidal_connected: z.union([z.literal(0), z.literal(1)]),
})

export type GuildSettings = {
  readonly volume: Volume
  readonly loopMode: LoopMode
  readonly sourcePreference: MediaSourcePreference
  readonly mockTidalConnected: boolean
}

const defaultSettings: GuildSettings = {
  volume: VolumeSchema.parse(100),
  loopMode: "off",
  sourcePreference: "youtube_only",
  mockTidalConnected: false,
}

export class SettingsRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock,
  ) {}

  get(guildId: GuildId): GuildSettings {
    const raw = this.database
      .prepare(`
        SELECT guild_id, volume, loop_mode, source_preference, mock_tidal_connected
        FROM guild_settings
        WHERE guild_id = ?
      `)
      .get(guildId)
    if (raw === undefined) return defaultSettings
    const row = settingsRowSchema.parse(raw)
    return {
      volume: row.volume,
      loopMode: row.loop_mode,
      sourcePreference: row.source_preference,
      mockTidalConnected: row.mock_tidal_connected === 1,
    }
  }

  set(guildId: GuildId, settings: GuildSettings): void {
    const parsedGuildId = GuildIdSchema.parse(guildId)
    const parsedVolume = VolumeSchema.parse(settings.volume)
    const parsedLoopMode = LoopModeSchema.parse(settings.loopMode)
    const parsedPreference = MediaSourcePreferenceSchema.parse(settings.sourcePreference)
    const connected = settings.mockTidalConnected ? 1 : 0
    this.database
      .prepare(`
        INSERT INTO guild_settings (
          guild_id, volume, loop_mode, source_preference, mock_tidal_connected, updated_at_ms
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (guild_id) DO UPDATE SET
          volume = excluded.volume,
          loop_mode = excluded.loop_mode,
          source_preference = excluded.source_preference,
          mock_tidal_connected = excluded.mock_tidal_connected,
          updated_at_ms = excluded.updated_at_ms
      `)
      .run(
        parsedGuildId,
        parsedVolume,
        parsedLoopMode,
        parsedPreference,
        connected,
        this.clock.now().getTime(),
      )
  }
}
