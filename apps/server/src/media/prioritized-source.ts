import {
  type MediaProviderSettings,
  MediaProviderSettingsSchema,
  type MediaSourcePreference,
} from "@discord-music/contracts"

import type { MockTidalMusicSource } from "./mock-tidal.js"
import type { MusicSource, PlayableMedia, PlaylistSource, ProviderController } from "./types.js"

export class PrioritizedMusicSource implements MusicSource, PlaylistSource, ProviderController {
  private currentSettings: MediaProviderSettings

  constructor(
    private readonly mockTidal: MockTidalMusicSource,
    private readonly fallback: MusicSource & PlaylistSource,
    settings: MediaProviderSettings,
  ) {
    this.currentSettings = MediaProviderSettingsSchema.parse(settings)
  }

  async search(query: string, signal?: AbortSignal) {
    if (
      this.currentSettings.preference === "mock_tidal_first" &&
      this.currentSettings.mockTidalConnected
    ) {
      const local = await this.mockTidal.search(query, signal)
      if (local.length > 0) return local
    }
    return this.fallback.search(query, signal)
  }

  resolve(
    track: Parameters<MusicSource["resolve"]>[0],
    signal?: AbortSignal,
  ): Promise<PlayableMedia> {
    return track.provider === "mock_tidal"
      ? this.mockTidal.resolve(track, signal)
      : this.fallback.resolve(track, signal)
  }

  playlist(url: string, signal?: AbortSignal) {
    return this.fallback.playlist(url, signal)
  }

  settings(): MediaProviderSettings {
    return this.currentSettings
  }

  setPreference(preference: MediaSourcePreference): void {
    this.currentSettings = MediaProviderSettingsSchema.parse({
      ...this.currentSettings,
      preference,
    })
  }

  connectMockTidal(): void {
    this.currentSettings = { preference: "mock_tidal_first", mockTidalConnected: true }
  }

  disconnectMockTidal(): void {
    this.currentSettings = { preference: "youtube_only", mockTidalConnected: false }
  }

  close(): Promise<void> {
    return this.mockTidal.close()
  }
}
