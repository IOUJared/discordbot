import type {
  ChannelId,
  GuildId,
  HistoryItem,
  LoopMode,
  Volume,
} from "@discord-music/contracts"

import type { PlayableMedia } from "../media/types.js"

export interface AudioResource {
  dispose(): void
}

export interface AudioResourceFactory {
  create(media: PlayableMedia, offsetMs: number, signal?: AbortSignal): Promise<AudioResource>
}

export type PlaybackCallbacks = {
  readonly finished: () => Promise<void>
  readonly failed: (error: Error) => Promise<void>
}

export type VoiceStateEvent =
  | { readonly kind: "connected"; readonly channelId: ChannelId }
  | { readonly kind: "disconnected" }

export interface VoiceGateway {
  join(guildId: GuildId, channelId: ChannelId): Promise<void>
  leave(): Promise<void>
  play(resource: AudioResource, callbacks: PlaybackCallbacks): void
  pause(): boolean
  resume(): boolean
  stop(): void
  setVolume(volume: Volume): void
  onStatus(listener: (event: VoiceStateEvent) => void): () => void
}

export interface PlayerScheduler {
  schedule(callback: () => void, delayMs: number): () => void
}

export type StoredSettings = {
  readonly volume: Volume
  readonly loopMode: LoopMode
}

export interface SettingsPort {
  get(guildId: GuildId): StoredSettings
  set(guildId: GuildId, settings: StoredSettings): void
}

export interface HistoryPort {
  append(guildId: GuildId, item: HistoryItem): void
}

export const systemScheduler: PlayerScheduler = {
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}
