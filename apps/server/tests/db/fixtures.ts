import {
  ChannelIdSchema,
  DurationMsSchema,
  GuildIdSchema,
  type HistoryItem,
  HistoryItemIdSchema,
  QueueItemIdSchema,
  TimestampSchema,
  TrackIdSchema,
  UserIdSchema,
} from "@discord-music/contracts"
import type { Random } from "../../src/db/random.js"
import type { Clock } from "../../src/domain/clock.js"

export const GUILD_ID = GuildIdSchema.parse("guild-1")
export const USER_ID = UserIdSchema.parse("user-1")

export class FixedClock implements Clock {
  constructor(private instant: Date) {}

  now(): Date {
    return new Date(this.instant)
  }

  advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds)
  }
}

export class SequenceRandom implements Random {
  private index = 0

  constructor(private readonly values: readonly string[]) {}

  token(): string {
    const value = this.values[this.index]
    if (value === undefined) {
      throw new RangeError("test token sequence exhausted")
    }
    this.index += 1
    return value
  }
}

export function historyItem(index: number): HistoryItem {
  const timestamp = TimestampSchema.parse(new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString())
  return {
    id: HistoryItemIdSchema.parse(`history-${index}`),
    queueItem: {
      id: QueueItemIdSchema.parse(`queue-${index}`),
      track: {
        id: TrackIdSchema.parse(`track-${index}`),
        provider: "youtube",
        title: `Track ${index}`,
        artist: "Artist",
        url: `https://example.com/tracks/${index}`,
        durationMs: DurationMsSchema.parse(180_000),
      },
      requestedBy: USER_ID,
      addedAt: timestamp,
    },
    playedAt: timestamp,
    endedAt: timestamp,
    endReason: "finished",
  }
}

export const CHANNEL_ID = ChannelIdSchema.parse("channel-1")
