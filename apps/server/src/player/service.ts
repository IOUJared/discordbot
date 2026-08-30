import {
  type ChannelId,
  type LoopMode,
  type MediaProviderSettings,
  type MediaSourcePreference,
  type PlaybackFailureNotification,
  type PlayerSnapshot,
  PositionMsSchema,
  type QueueItem,
  QueueItemIdSchema,
  TimestampSchema,
  type Track,
  type UserId,
  type Volume,
  VolumeSchema,
} from "@discord-music/contracts"
import { IdleController } from "./idle-controller.js"
import { PlaybackFailurePublisher } from "./playback-failure.js"
import { PlaybackHistory } from "./playback-history.js"
import { PlaybackSession } from "./playback-session.js"
import { QueueControls } from "./queue-controls.js"
import { validateSeekOffset } from "./seek.js"
import type { PlayerServiceOptions } from "./service-options.js"
import { VoiceStateTracker } from "./voice-state-tracker.js"
import { createVoiceStatus } from "./voice-status.js"

export class PlayerService extends QueueControls {
  private readonly history: PlaybackHistory
  private readonly idle: IdleController
  private readonly playback: PlaybackSession
  private readonly failures: PlaybackFailurePublisher
  private readonly voiceState: VoiceStateTracker
  private volume: Volume
  private loopMode: LoopMode
  private readonly stateListeners = new Set<() => void>()

  constructor(private readonly options: PlayerServiceOptions) {
    super(options.random)
    this.history = new PlaybackHistory({
      guildId: options.guildId,
      port: options.history,
      clock: options.clock,
      nextId: options.nextId,
    })
    this.idle = new IdleController(options.scheduler, options.voiceIdleTimeoutMs, () => {
      void this.leave()
    })
    this.playback = new PlaybackSession(options.source, options.resourceFactory, options.clock)
    this.failures = new PlaybackFailurePublisher(options.guildId, options.reportFailure)
    this.voiceState = new VoiceStateTracker(options.voice, () => this.emitState())
    const settings = options.settings?.get(options.guildId)
    this.volume = settings?.volume ?? VolumeSchema.parse(100)
    this.loopMode = settings?.loopMode ?? "off"
    if (settings !== undefined) {
      if (settings.mockTidalConnected) this.options.providers.connectMockTidal()
      else this.options.providers.disconnectMockTidal()
      this.options.providers.setPreference(settings.sourcePreference)
    }
  }

  async join(channelId: ChannelId): Promise<void> {
    this.idle.cancel()
    await this.options.voice.join(this.options.guildId, channelId)
  }

  async leave(): Promise<void> {
    this.stop()
    this.idle.cancel()
    await this.options.voice.leave()
  }

  async play(query: string, requestedBy: UserId, channelId: ChannelId): Promise<QueueItem> {
    const results = await this.options.source.search(query)
    const first = results.at(0)
    if (first === undefined) throw new RangeError("No tracks matched the query")
    await this.join(channelId)
    const item = await this.enqueue(first.track, requestedBy)
    await this.startIfIdle()
    return item
  }

  async enqueue(track: Track, requestedBy: UserId): Promise<QueueItem> {
    const item: QueueItem = {
      id: QueueItemIdSchema.parse(this.options.nextId()),
      track,
      requestedBy,
      addedAt: TimestampSchema.parse(this.options.clock.now().toISOString()),
    }
    this.queue.push(item)
    this.emitState()
    return item
  }

  async startIfIdle(): Promise<void> {
    if (this.playback.current !== null) return
    const next = this.queue.shift()
    if (next === undefined) {
      this.idle.schedule()
      return
    }
    await this.startPlayback(next, 0)
  }

  pause(): boolean {
    if (this.playback.current === null || this.playback.isPaused) return false
    if (!this.options.voice.pause()) return false
    this.playback.pause()
    this.emitState()
    return true
  }

  resume(): boolean {
    if (this.playback.current === null || !this.playback.isPaused) return false
    if (!this.options.voice.resume()) return false
    this.playback.resume()
    this.emitState()
    return true
  }

  async skip(): Promise<void> {
    if (this.playback.current === null) return
    this.options.voice.stop()
    this.playback.invalidate()
    this.history.append(this.playback.current, this.playback.playedAt, "skipped")
    this.resetCurrent()
    await this.startIfIdle()
  }

  async next(): Promise<void> {
    await this.skip()
  }

  stop(): void {
    this.queue.clear()
    if (this.playback.current !== null) {
      this.history.append(this.playback.current, this.playback.playedAt, "stopped")
    }
    this.playback.invalidate()
    this.options.voice.stop()
    this.resetCurrent()
    this.idle.schedule()
  }

  async restart(): Promise<void> {
    if (this.playback.current === null) throw new RangeError("Nothing is playing")
    await this.startPlayback(this.playback.current, 0)
  }

  async seek(offsetMs: number): Promise<void> {
    if (this.playback.current === null) throw new RangeError("Nothing is playing")
    if (!this.playback.seekable) throw new RangeError("Media does not support seeking")
    validateSeekOffset(offsetMs, this.playback.current.track.durationMs)
    await this.startPlayback(this.playback.current, offsetMs)
  }

  setVolume(volume: Volume): void {
    this.volume = VolumeSchema.parse(volume)
    this.options.voice.setVolume(this.volume)
    this.persistSettings()
  }

  setLoop(loopMode: LoopMode): void {
    this.loopMode = loopMode
    this.persistSettings()
  }

  providerSettings(): MediaProviderSettings {
    return this.options.providers.settings()
  }

  setSourcePreference(preference: MediaSourcePreference): void {
    this.options.providers.setPreference(preference)
    this.persistSettings()
  }

  connectMockTidal(): void {
    this.options.providers.connectMockTidal()
    this.persistSettings()
  }

  disconnectMockTidal(): void {
    this.options.providers.disconnectMockTidal()
    this.persistSettings()
  }

  async playSelected(id: QueueItem["id"]): Promise<void> {
    const selected = this.queue.remove(id)
    if (this.playback.current !== null) {
      this.options.voice.stop()
      this.playback.invalidate()
      this.history.append(this.playback.current, this.playback.playedAt, "skipped")
    }
    this.resetCurrent()
    await this.startPlayback(selected, 0)
  }

  snapshot(): PlayerSnapshot {
    return {
      guildId: this.options.guildId,
      queue: this.queue.list(),
      currentItem: this.playback.current,
      seekable: this.playback.seekable,
      positionMs: PositionMsSchema.parse(this.playback.position()),
      volume: this.volume,
      isPaused: this.playback.isPaused,
      loopMode: this.loopMode,
    }
  }

  voiceStatus() {
    return createVoiceStatus(this.options.guildId, this.voiceState.channelId)
  }

  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onPlaybackFailure(listener: (notification: PlaybackFailureNotification) => void): () => void {
    return this.failures.subscribe(listener)
  }

  private async startPlayback(item: QueueItem, offsetMs: number): Promise<void> {
    this.idle.cancel()
    const start = this.playback.begin(item, offsetMs)
    try {
      const resource = await this.playback.prepare(start)
      if (resource === null) return
      this.options.voice.setVolume(this.volume)
      this.options.voice.play(resource, {
        finished: async () => this.handleFinished(start.generation),
        failed: async (error) => this.handleFailed(start.generation, error),
      })
      this.emitState()
    } catch (error) {
      if (error instanceof Error) await this.handleFailed(start.generation, error)
      else throw error
    }
  }

  private async handleFinished(generation: number): Promise<void> {
    if (!this.playback.isActive(generation) || this.playback.current === null) return
    const finished = this.playback.current
    this.history.append(finished, this.playback.playedAt, "finished")
    this.resetCurrent()
    if (this.loopMode === "track") {
      await this.startPlayback(finished, 0)
      return
    }
    if (this.loopMode === "queue") this.queue.push(finished)
    await this.startIfIdle()
  }

  private async handleFailed(generation: number, error: Error): Promise<void> {
    if (!this.playback.isActive(generation) || this.playback.current === null) return
    const failed = this.playback.current
    this.history.append(failed, this.playback.playedAt, "errored")
    this.failures.publish(failed, error)
    this.resetCurrent()
    await this.startIfIdle()
  }

  private resetCurrent(): void {
    this.playback.reset()
    this.emitState()
  }

  private persistSettings(): void {
    const providers = this.options.providers.settings()
    this.options.settings?.set(this.options.guildId, {
      volume: this.volume,
      loopMode: this.loopMode,
      sourcePreference: providers.preference,
      mockTidalConnected: providers.mockTidalConnected,
    })
  }

  private emitState(): void {
    for (const listener of this.stateListeners) listener()
  }
}
