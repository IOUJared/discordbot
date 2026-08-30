import type { GuildId } from "@discord-music/contracts"

import type { Clock } from "../domain/clock.js"
import type { MusicSource, ProviderController } from "../media/types.js"
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
  readonly nextId: () => string
  readonly random: () => number
  readonly settings?: SettingsPort
  readonly history?: HistoryPort
}
