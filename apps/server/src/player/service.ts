import {
  type ChannelId,
  type LoopMode,
  type MediaProviderSettings,
  type MediaSourcePreference,
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
import { PlaybackHistory } from "./playback-history.js"
import type { AudioResource } from "./ports.js"
import { QueueControls } from "./queue-controls.js"
import { validateSeekOffset } from "./seek.js"
import type { PlayerServiceOptions } from "./service-options.js"
import { VoiceStateTracker } from "./voice-state-tracker.js"
import { createVoiceStatus } from "./voice-status.js"

export class PlayerService extends QueueControls {
  private readonly history: PlaybackHistory
  private readonly idle: IdleController
  private readonly voiceState: VoiceStateTracker
  private current: QueueItem | null = null
  private currentResource: AudioResource | null = null
  private activeAbort: AbortController | null = null
  private basePositionMs = 0
  private startedAtMs = 0
  private paused = false
  private generation = 0
  private playedAt = ""
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
    this.idle = new IdleController(options.scheduler, () => {
      void this.leave()
    })
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
    if (this.current !== null) return
    const next = this.queue.shift()
    if (next === undefined) {
      this.idle.schedule()
      return
    }
    await this.startPlayback(next, 0)
  }

  pause(): boolean {
    if (this.current === null || this.paused) return false
    if (!this.options.voice.pause()) return false
    this.basePositionMs = this.position()
    this.paused = true
    this.emitState()
    return true
  }

  resume(): boolean {
    if (this.current === null || !this.paused) return false
    if (!this.options.voice.resume()) return false
    this.startedAtMs = this.options.clock.now().getTime()
    this.paused = false
    this.emitState()
    return true
  }

  async skip(): Promise<void> {
    if (this.current === null) return
    this.options.voice.stop()
    this.generation += 1
    this.history.append(this.current, this.playedAt, "skipped")
    this.resetCurrent()
    await this.startIfIdle()
  }

  async next(): Promise<void> {
    await this.skip()
  }

  stop(): void {
    this.queue.clear()
    if (this.current !== null) this.history.append(this.current, this.playedAt, "stopped")
    this.generation += 1
    this.options.voice.stop()
    this.resetCurrent()
    this.idle.schedule()
  }

  async restart(): Promise<void> {
    if (this.current === null) throw new RangeError("Nothing is playing")
    await this.startPlayback(this.current, 0)
  }

  async seek(offsetMs: number): Promise<void> {
    if (this.current === null) throw new RangeError("Nothing is playing")
    validateSeekOffset(offsetMs, this.current.track.durationMs)
    await this.startPlayback(this.current, offsetMs)
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
    if (this.current !== null) {
      this.options.voice.stop()
      this.generation += 1
      this.history.append(this.current, this.playedAt, "skipped")
    }
    this.resetCurrent()
    await this.startPlayback(selected, 0)
  }

  snapshot(): PlayerSnapshot {
    return {
      guildId: this.options.guildId,
      queue: this.queue.list(),
      currentItem: this.current,
      positionMs: PositionMsSchema.parse(this.position()),
      volume: this.volume,
      isPaused: this.paused,
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

  private async startPlayback(item: QueueItem, offsetMs: number): Promise<void> {
    this.idle.cancel()
    this.activeAbort?.abort()
    const abort = new AbortController()
    this.activeAbort = abort
    const generation = ++this.generation
    this.current = item
    this.basePositionMs = offsetMs
    this.startedAtMs = this.options.clock.now().getTime()
    this.playedAt = TimestampSchema.parse(this.options.clock.now().toISOString())
    this.paused = false
    this.currentResource?.dispose()
    try {
      const media = await this.options.source.resolve(item.track, abort.signal)
      if (offsetMs > 0 && !media.seekable) throw new RangeError("Media does not support seeking")
      const resource = await this.options.resourceFactory.create(media, offsetMs, abort.signal)
      if (generation !== this.generation) {
        resource.dispose()
        return
      }
      this.currentResource = resource
      this.options.voice.setVolume(this.volume)
      this.options.voice.play(resource, {
        finished: async () => this.handleFinished(generation),
        failed: async () => this.handleFailed(generation),
      })
      this.emitState()
    } catch (error) {
      if (error instanceof Error) await this.handleFailed(generation)
      else throw error
    }
  }

  private async handleFinished(generation: number): Promise<void> {
    if (generation !== this.generation || this.current === null) return
    const finished = this.current
    this.history.append(finished, this.playedAt, "finished")
    this.resetCurrent()
    if (this.loopMode === "track") {
      await this.startPlayback(finished, 0)
      return
    }
    if (this.loopMode === "queue") this.queue.push(finished)
    await this.startIfIdle()
  }

  private async handleFailed(generation: number): Promise<void> {
    if (generation !== this.generation || this.current === null) return
    this.history.append(this.current, this.playedAt, "errored")
    this.resetCurrent()
    await this.startIfIdle()
  }

  private position(): number {
    if (this.current === null) return 0
    const elapsed = this.paused ? 0 : this.options.clock.now().getTime() - this.startedAtMs
    return Math.min(this.current.track.durationMs, this.basePositionMs + elapsed)
  }

  private resetCurrent(): void {
    this.currentResource?.dispose()
    this.activeAbort?.abort()
    this.activeAbort = null
    this.currentResource = null
    this.current = null
    this.basePositionMs = 0
    this.paused = false
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
