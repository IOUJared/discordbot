import {
  DurationMsSchema,
  GuildIdSchema,
  type PlayerSnapshot,
  PositionMsSchema,
  QueueItemIdSchema,
  TimestampSchema,
  TrackIdSchema,
  UserIdSchema,
  VolumeSchema,
} from "@discord-music/contracts"
import { describe, expect, it } from "vitest"

import {
  type PresenceClient,
  type SnapshotSource,
  wirePresence,
} from "../../src/discord/presence-publisher.js"

class FakeSource implements SnapshotSource {
  listener: (() => void) | null = null
  constructor(public value: PlayerSnapshot) {}
  snapshot() {
    return this.value
  }
  onStateChange(listener: () => void) {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }
}

class FakePresenceClient implements PresenceClient {
  ready: () => void = () => undefined
  readonly published: unknown[] = []
  onReady(listener: () => void) {
    this.ready = listener
  }
  setPresence(presence: unknown) {
    this.published.push(presence)
  }
}

function idleSnapshot(): PlayerSnapshot {
  return {
    guildId: GuildIdSchema.parse("guild-1"),
    queue: [],
    currentItem: null,
    positionMs: PositionMsSchema.parse(0),
    volume: VolumeSchema.parse(100),
    isPaused: false,
    loopMode: "off",
  }
}

function playingSnapshot(): PlayerSnapshot {
  return {
    ...idleSnapshot(),
    currentItem: {
      id: QueueItemIdSchema.parse("queue-1"),
      requestedBy: UserIdSchema.parse("owner"),
      addedAt: TimestampSchema.parse("2026-01-01T00:00:00.000Z"),
      track: {
        id: TrackIdSchema.parse("track-1"),
        provider: "youtube",
        title: "Song",
        artist: "Artist",
        url: "https://secret.invalid/?token=no",
        durationMs: DurationMsSchema.parse(1_000),
      },
    },
  }
}

describe("Discord presence publisher", () => {
  it("publishes idle on ready and playing on player state change", () => {
    // Given
    const client = new FakePresenceClient()
    const source = new FakeSource(idleSnapshot())
    wirePresence(client, source)

    // When
    client.ready()
    source.value = playingSnapshot()
    source.listener?.()

    // Then
    expect(client.published).toMatchObject([
      { status: "idle" },
      { status: "online", activities: [{ name: "Song" }] },
    ])
    expect(JSON.stringify(client.published)).not.toContain("token=no")
  })

  it("reports a redacted typed error when Discord rejects presence", () => {
    // Given
    const errors: Error[] = []
    const client: PresenceClient = {
      onReady: () => undefined,
      setPresence: () => {
        throw new Error("https://secret.invalid/?token=no")
      },
    }
    const source = new FakeSource(idleSnapshot())

    // When
    wirePresence(client, source, (error) => errors.push(error))
    source.listener?.()

    // Then
    expect(errors.at(0)?.message).toBe("Discord presence update failed")
  })
})
