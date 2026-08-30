import {
  type GuildId,
  HistoryItemIdSchema,
  type QueueItem,
  TimestampSchema,
} from "@discord-music/contracts"

import type { Clock } from "../domain/clock.js"
import type { HistoryPort } from "./ports.js"

type EndReason = "finished" | "skipped" | "stopped" | "errored"

export type PlaybackHistoryOptions = {
  readonly guildId: GuildId
  readonly port: HistoryPort | undefined
  readonly clock: Clock
  readonly nextId: () => string
}

export class PlaybackHistory {
  constructor(private readonly options: PlaybackHistoryOptions) {}

  append(queueItem: QueueItem, playedAt: string, endReason: EndReason): void {
    if (this.options.port === undefined) return
    const endedAt = TimestampSchema.parse(this.options.clock.now().toISOString())
    this.options.port.append(this.options.guildId, {
      id: HistoryItemIdSchema.parse(this.options.nextId()),
      queueItem,
      playedAt: TimestampSchema.parse(playedAt),
      endedAt,
      endReason,
    })
  }
}
