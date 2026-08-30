import {
  DurationMsSchema,
  GuildIdSchema,
  PositionMsSchema,
  QueueItemIdSchema,
  TimestampSchema,
  TrackIdSchema,
  UserIdSchema,
  VolumeSchema,
} from "@discord-music/contracts"
import { ActivityType } from "discord.js"
import { describe, expect, it } from "vitest"

import { presenceFor } from "../../src/discord/presence.js"

const guildId = GuildIdSchema.parse("guild-1")

describe("Discord presence", () => {
  it("publishes the current title without exposing its URL", () => {
    // Given
    const currentItem = {
      id: QueueItemIdSchema.parse("queue-1"),
      track: {
        id: TrackIdSchema.parse("track-1"),
        provider: "youtube" as const,
        title: "Visible title",
        artist: "Artist",
        url: "https://media.example/audio?token=secret",
        durationMs: DurationMsSchema.parse(1_000),
      },
      requestedBy: UserIdSchema.parse("owner"),
      addedAt: TimestampSchema.parse("2026-01-01T00:00:00.000Z"),
    }

    // When
    const presence = presenceFor({
      guildId,
      queue: [],
      currentItem,
      positionMs: PositionMsSchema.parse(0),
      volume: VolumeSchema.parse(100),
      isPaused: false,
      loopMode: "off",
    })

    // Then
    expect(presence.activities).toEqual([{ name: "Visible title", type: ActivityType.Listening }])
  })

  it("publishes idle presence when playback is empty", () => {
    // Given
    const snapshot = {
      guildId,
      queue: [],
      currentItem: null,
      positionMs: PositionMsSchema.parse(0),
      volume: VolumeSchema.parse(100),
      isPaused: false,
      loopMode: "off" as const,
    }

    // When
    const presence = presenceFor(snapshot)

    // Then
    expect(presence).toEqual({ status: "idle", activities: [] })
  })
})
