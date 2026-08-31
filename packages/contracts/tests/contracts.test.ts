import { describe, expect, it } from "vitest"

import {
  MediaProviderSettingsSchema,
  MediaSourcePreferenceSchema,
  PlaybackFailureMessageSchema,
  PlayerSnapshotSchema,
  SetVolumeRequestSchema,
  TrackSchema,
  WebSocketMessageSchema,
} from "../src/index.js"

const track = {
  id: "youtube:abc123",
  provider: "youtube",
  title: "A deterministic track",
  artist: "Artist",
  url: "https://www.youtube.com/watch?v=abc123",
  durationMs: 180_000,
  artworkUrl: "https://example.test/art/abc123.png",
}

const firstQueueItem = {
  id: "queue:001",
  track,
  requestedBy: "user:001",
  addedAt: "2026-08-29T12:00:00.000Z",
}

const secondQueueItem = {
  id: "queue:002",
  track,
  requestedBy: "user:002",
  addedAt: "2026-08-29T12:01:00.000Z",
}

describe("contracts", () => {
  it("rejects a loopback URL presented as a YouTube track", () => {
    // Given: an authenticated client-authored track targeting loopback.
    const loopbackTrack = {
      ...track,
      url: "http://127.0.0.1:38917/test.wav",
    }

    // When: the track crosses the shared API contract boundary.
    const result = TrackSchema.safeParse(loopbackTrack)

    // Then: the URL cannot become playback authority.
    expect(result.success).toBe(false)
  })

  it.each([
    ["spotify", "https://open.spotify.com/track/abc"],
    ["url", "https://www.youtube.com/watch?v=abc123"],
    ["youtube", "http://www.youtube.com/watch?v=abc123"],
    ["youtube", "https://youtube.com/watch?v=abc123"],
    ["youtube", "https://www.youtube.com:443/watch?v=abc123"],
    ["youtube", "https://user@www.youtube.com/watch?v=abc123"],
  ])("rejects unsupported provider or noncanonical URL: %s %s", (provider, url) => {
    // Given: a track outside the implemented provider URL contract.
    const candidate = { ...track, provider, url }

    // When: the candidate crosses the track boundary.
    const result = TrackSchema.safeParse(candidate)

    // Then: only server-generated canonical provider tracks are accepted.
    expect(result.success).toBe(false)
  })

  it("parses and serializes a valid player snapshot", () => {
    // Given: a complete player snapshot received over an API boundary.
    const snapshot = {
      guildId: "guild:001",
      queue: [firstQueueItem, secondQueueItem],
      currentItem: firstQueueItem,
      bitrateKbps: 252,
      seekable: false,
      positionMs: 12_345,
      volume: 100,
      isPaused: false,
      loopMode: "queue",
    }

    // When: the boundary schema parses and serializes the snapshot.
    const parsed = PlayerSnapshotSchema.parse(snapshot)
    const serialized = JSON.stringify(parsed)

    // Then: the serialized wire value retains the parsed playback state.
    expect(JSON.parse(serialized)).toMatchObject({
      currentItem: { id: "queue:001" },
      bitrateKbps: 252,
      seekable: false,
      loopMode: "queue",
      volume: 100,
    })
  })

  it("rejects malformed boundary values", () => {
    // Given: independently invalid client-provided values.
    const invalidIdentifierTrack = { ...track, id: "   " }
    const negativeDurationTrack = { ...track, durationMs: -1 }
    const invalidVolume = { volume: 201 }

    // When: each value crosses its schema boundary.
    const identifierResult = PlayerSnapshotSchema.safeParse({
      guildId: "guild:001",
      queue: [],
      currentItem: { ...firstQueueItem, track: invalidIdentifierTrack },
      seekable: false,
      positionMs: 0,
      volume: 100,
      isPaused: false,
      loopMode: "off",
    })
    const durationResult = PlayerSnapshotSchema.safeParse({
      guildId: "guild:001",
      queue: [],
      currentItem: { ...firstQueueItem, track: negativeDurationTrack },
      seekable: false,
      positionMs: 0,
      volume: 100,
      isPaused: false,
      loopMode: "off",
    })
    const volumeResult = SetVolumeRequestSchema.safeParse(invalidVolume)
    const messageResult = WebSocketMessageSchema.safeParse({ version: 1, type: "unknown.event" })
    const preferenceResult = MediaSourcePreferenceSchema.safeParse("tidal_real")
    const providerSettings = MediaProviderSettingsSchema.parse({
      preference: "mock_tidal_first",
      mockTidalConnected: true,
    })

    // Then: malformed identifiers, negative durations, excessive volume, and unknown messages fail.
    expect(identifierResult.success).toBe(false)
    expect(durationResult.success).toBe(false)
    expect(volumeResult.success).toBe(false)
    expect(messageResult.success).toBe(false)
    expect(preferenceResult.success).toBe(false)
    expect(providerSettings).toEqual({
      preference: "mock_tidal_first",
      mockTidalConnected: true,
    })
  })

  it("keeps duplicate tracks distinct through queue item identity", () => {
    // Given: the same track was requested twice by different listeners.
    const snapshot = {
      guildId: "guild:001",
      queue: [firstQueueItem, secondQueueItem],
      currentItem: null,
      seekable: false,
      positionMs: 0,
      volume: 100,
      isPaused: true,
      loopMode: "off",
    }

    // When: the queue is parsed at the player boundary.
    const parsed = PlayerSnapshotSchema.parse(snapshot)

    // Then: both entries remain distinguishable even though their Track IDs match.
    expect(parsed.queue.map((item) => item.track.id)).toEqual(["youtube:abc123", "youtube:abc123"])
    expect(new Set(parsed.queue.map((item) => item.id)).size).toBe(2)
  })

  it("parses a redacted versioned playback failure notification", () => {
    // Given
    const message = {
      version: 1,
      type: "playback.failed",
      payload: {
        guildId: "guild:001",
        queueItemId: "queue:001",
        trackId: "youtube:abc123",
        provider: "youtube",
        title: "A deterministic track",
        artist: "Artist",
        message: "Playback failed; skipped to the next track.",
      },
    }

    // When
    const parsed = PlaybackFailureMessageSchema.parse(message)

    // Then
    expect(parsed.payload).toEqual(message.payload)
    expect(JSON.stringify(parsed)).not.toContain("stack")
  })
})
