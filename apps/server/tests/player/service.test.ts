import {
  ChannelIdSchema,
  DurationMsSchema,
  GuildIdSchema,
  type MediaProviderSettings,
  type Track,
  TrackIdSchema,
  UserIdSchema,
  VolumeSchema,
} from "@discord-music/contracts"
import { describe, expect, it } from "vitest"

import type { MusicSource, PlayableMedia, ProviderController } from "../../src/media/types.js"
import type {
  AudioResource,
  AudioResourceFactory,
  PlaybackCallbacks,
  PlayerScheduler,
  SettingsPort,
  VoiceGateway,
  VoiceStateEvent,
} from "../../src/player/ports.js"
import { PlayerService } from "../../src/player/service.js"
import { FixedClock } from "../db/fixtures.js"

const guildId = GuildIdSchema.parse("guild-1")
const channelId = ChannelIdSchema.parse("voice-1")
const userId = UserIdSchema.parse("owner")
const playable: PlayableMedia = {
  kind: "local",
  url: "https://media.example/audio?token=redacted",
  headers: {},
  container: "webm",
  codec: "opus",
  seekable: true,
}
function track(index: number): Track {
  return {
    id: TrackIdSchema.parse(`track-${index}`),
    provider: "youtube",
    title: `Track ${index}`,
    artist: "Artist",
    url: `https://youtube.example/watch?v=${index}`,
    durationMs: DurationMsSchema.parse(180_000),
  }
}
const trackOne = track(1)

class FakeSource implements MusicSource {
  resolveCount = 0
  failTrackId: string | null = null
  seekable = true

  async search() {
    return [trackOne, track(2), track(3)].map((track) => ({ track, score: 1 }))
  }

  async resolve(track: Track) {
    this.resolveCount += 1
    if (track.id === this.failTrackId) throw new RangeError("unplayable fixture")
    return { ...playable, seekable: this.seekable }
  }
}

class FakeProviders implements ProviderController {
  private value: MediaProviderSettings = {
    preference: "youtube_only",
    mockTidalConnected: false,
  }
  settings() {
    return this.value
  }
  setPreference(preference: "mock_tidal_first" | "youtube_only") {
    this.value = { ...this.value, preference }
  }
  connectMockTidal() {
    this.value = { preference: "mock_tidal_first", mockTidalConnected: true }
  }
  disconnectMockTidal() {
    this.value = { preference: "youtube_only", mockTidalConnected: false }
  }
  async close() {}
}

class FakeVoice implements VoiceGateway {
  callbacks: PlaybackCallbacks | null = null
  connected = false
  pauses = 0
  resumes = 0
  stops = 0
  listener: ((event: VoiceStateEvent) => void) | null = null

  async join() {
    this.connected = true
    this.listener?.({ kind: "connected", channelId })
  }
  async leave() {
    this.connected = false
    this.listener?.({ kind: "disconnected" })
  }
  play(_resource: AudioResource, callbacks: PlaybackCallbacks) {
    this.callbacks = callbacks
  }
  pause() {
    this.pauses += 1
    return true
  }
  resume() {
    this.resumes += 1
    return true
  }
  stop() {
    this.stops += 1
  }
  setVolume() {}
  onStatus(listener: (event: VoiceStateEvent) => void) {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }
}

class FakeScheduler implements PlayerScheduler {
  callback: (() => void) | null = null
  delayMs: number | null = null
  schedule(callback: () => void, delayMs: number) {
    this.callback = callback
    this.delayMs = delayMs
    return () => {
      this.callback = null
    }
  }
}

function harness(settings?: SettingsPort, voiceIdleTimeoutMs = 300_000) {
  const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"))
  const source = new FakeSource()
  const providers = new FakeProviders()
  const voice = new FakeVoice()
  const scheduler = new FakeScheduler()
  let sequence = 0
  const resources: number[] = []
  const failures: unknown[] = []
  const factory: AudioResourceFactory = {
    create: async (_media, offsetMs) => {
      resources.push(offsetMs)
      return { dispose: () => undefined }
    },
  }
  const service = new PlayerService({
    guildId,
    source,
    providers,
    voice,
    resourceFactory: factory,
    clock,
    scheduler,
    voiceIdleTimeoutMs,
    nextId: () => `generated-${sequence++}`,
    random: () => 0,
    reportFailure: (failure) => failures.push(failure),
    ...(settings === undefined ? {} : { settings }),
  })
  return { clock, failures, providers, resources, scheduler, service, source, voice }
}

describe("PlayerService", () => {
  it("Given an ordered playlist When it is enqueued Then one state change contains every track in order", async () => {
    // Given
    const { service } = harness()
    let changes = 0
    service.onStateChange(() => {
      changes += 1
    })

    // When
    await service.enqueueMany([track(1), track(2), track(3)], userId)

    // Then
    expect(service.snapshot().queue.map((item) => item.track.id)).toEqual([
      "track-1",
      "track-2",
      "track-3",
    ])
    expect(changes).toBe(1)
  })

  it("auto-joins and starts the first play result while preserving distinct request IDs", async () => {
    // Given
    const { service } = harness()

    // When
    await service.play("song", userId, channelId)
    await service.enqueue(trackOne, userId)

    // Then
    expect(service.snapshot()).toMatchObject({
      currentItem: { id: "generated-0" },
      queue: [{ id: "generated-1" }],
    })
  })

  it("tracks pause/resume position and rebuilds a fresh resource on seek/restart", async () => {
    // Given
    const { clock, resources, service, source } = harness()
    await service.join(channelId)
    await service.enqueue(trackOne, userId)
    await service.startIfIdle()
    clock.advance(5_000)

    // When
    service.pause()
    clock.advance(5_000)
    service.resume()
    await service.seek(12_000)
    await service.restart()

    // Then
    expect(resources).toEqual([0, 12_000, 0])
    expect(source.resolveCount).toBe(3)
    expect(service.snapshot().positionMs).toBe(0)
  })

  it("applies volume and queue-loop transitions", async () => {
    // Given
    const { service, voice } = harness()
    await service.enqueue(trackOne, userId)
    await service.startIfIdle()
    service.setLoop("queue")

    // When
    service.setVolume(VolumeSchema.parse(175))
    await voice.callbacks?.finished()

    // Then
    expect(service.snapshot()).toMatchObject({
      currentItem: { track: { id: "track-1" } },
      volume: 175,
      loopMode: "queue",
    })
  })

  it("connects the mock TIDAL simulator and persists provider priority", () => {
    // Given
    const saved: unknown[] = []
    const { service } = harness({
      get: () => ({
        volume: VolumeSchema.parse(100),
        loopMode: "off",
        sourcePreference: "youtube_only",
        mockTidalConnected: false,
      }),
      set: (_guild, settings) => saved.push(settings),
    })

    // When
    service.connectMockTidal()

    // Then
    expect(service.providerSettings()).toEqual({
      preference: "mock_tidal_first",
      mockTidalConnected: true,
    })
    expect(saved.at(-1)).toMatchObject({
      sourcePreference: "mock_tidal_first",
      mockTidalConnected: true,
    })
  })

  it("skips a failed track and continues with the next item", async () => {
    // Given
    const { service, source } = harness()
    source.failTrackId = "track-1"
    await service.enqueue(trackOne, userId)
    await service.enqueue(track(2), userId)

    // When
    await service.startIfIdle()

    // Then
    expect(service.snapshot().currentItem?.track.id).toBe("track-2")
  })

  it("rejects invalid or unsupported seek", async () => {
    // Given
    const { service } = harness()
    await service.enqueue(trackOne, userId)
    await service.startIfIdle()

    // When
    const seek = service.seek(999_000)

    // Then
    await expect(seek).rejects.toThrow(RangeError)
  })

  it("publishes resolved resource seekability and rejects seek without stopping playback", async () => {
    // Given
    const { service, source } = harness()
    source.seekable = false
    await service.enqueue(trackOne, userId)
    await service.startIfIdle()

    // When
    const seek = service.seek(12_000)

    // Then
    expect(service.snapshot().seekable).toBe(false)
    await expect(seek).rejects.toThrow("Media does not support seeking")
    expect(service.snapshot().currentItem?.track.id).toBe("track-1")
  })

  it("reports a redacted failure event and continues with the next item", async () => {
    // Given
    const { failures, service, source } = harness()
    const notifications: unknown[] = []
    service.onPlaybackFailure((notification) => notifications.push(notification))
    source.failTrackId = "track-1"
    await service.enqueue(trackOne, userId)
    await service.enqueue(track(2), userId)

    // When
    await service.startIfIdle()

    // Then
    expect(failures).toEqual([
      expect.objectContaining({
        event: "player.playback.failed",
        queueItemId: "generated-0",
        error: { type: "error", message: "[Redacted]" },
      }),
    ])
    expect(notifications).toEqual([
      expect.objectContaining({
        queueItemId: "generated-0",
        trackId: "track-1",
        message: "Playback failed; skipped to the next track.",
      }),
    ])
    expect(service.snapshot().currentItem?.track.id).toBe("track-2")
  })

  it("disconnects voice after the idle timer fires", async () => {
    // Given
    const { scheduler, service, voice } = harness()
    await service.join(channelId)
    await service.enqueue(trackOne, userId)
    await service.startIfIdle()

    // When
    service.stop()
    scheduler.callback?.()
    await Promise.resolve()

    // Then
    expect(voice.connected).toBe(false)
  })

  it("schedules idle disconnect with the configured exact delay", async () => {
    // Given
    const { scheduler, service } = harness(undefined, 42_000)
    await service.join(channelId)

    // When
    service.stop()

    // Then
    expect(scheduler.delayMs).toBe(42_000)
  })

  it("clears the published voice channel after a terminal gateway disconnect", async () => {
    // Given
    const { service, voice } = harness()
    await service.join(channelId)

    // When
    voice.listener?.({ kind: "disconnected" })

    // Then
    expect(service.voiceStatus()).toMatchObject({ connected: false, channelId: null })
  })
})
