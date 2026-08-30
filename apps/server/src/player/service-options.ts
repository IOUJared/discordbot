import type { GuildId } from "@discord-music/contracts"

import type { Clock } from "../domain/clock.js"
import type { MusicSource, ProviderController } from "../media/types.js"
import type { PlaybackFailureReporter } from "./playback-failure.js"
import type {
  AudioResourceFactory,
  HistoryPort,
  PlayerScheduler,
  SettingsPort,
  VoiceGateway,
} from "./ports.js"

export type PlayerServiceOptions = {
  readonly guildId: GuildId
  readonly source: MusicSource
  readonly providers: ProviderController
  readonly voice: VoiceGateway
  readonly resourceFactory: AudioResourceFactory
  readonly clock: Clock
  readonly scheduler: PlayerScheduler
  readonly voiceIdleTimeoutMs: number
  readonly nextId: () => string
  readonly random: () => number
  readonly settings?: SettingsPort
  readonly history?: HistoryPort
  readonly reportFailure?: PlaybackFailureReporter
}
