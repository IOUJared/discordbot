import type { BitrateKbps, QueueItem } from "@discord-music/contracts"

import type { Clock } from "../domain/clock.js"
import type { MusicSource, PlayableMedia } from "../media/types.js"
import type { AudioResource, AudioResourceFactory } from "./ports.js"

type PlaybackStart = {
  readonly generation: number
  readonly item: QueueItem
  readonly offsetMs: number
  readonly signal: AbortSignal
}

type PreloadedMedia = {
  readonly trackId: QueueItem["track"]["id"]
  readonly abort: AbortController
  readonly result: Promise<
    { readonly kind: "ready"; readonly media: PlayableMedia } | { readonly kind: "failed" }
  >
}

export class PlaybackSession {
  private item: QueueItem | null = null
  private resource: AudioResource | null = null
  private abort: AbortController | null = null
  private basePositionMs = 0
  private startedAtMs = 0
  private paused = false
  private sourceBitrateKbps: BitrateKbps | null = null
  private resourceSeekable = false
  private media: PlayableMedia | null = null
  private generation = 0
  private startedAt = ""
  private preloaded: PreloadedMedia | null = null

  constructor(
    private readonly source: MusicSource,
    private readonly resourceFactory: AudioResourceFactory,
    private readonly clock: Clock,
  ) {}

  get current(): QueueItem | null {
    return this.item
  }

  get isPaused(): boolean {
    return this.paused
  }

  get playedAt(): string {
    return this.startedAt
  }

  get seekable(): boolean {
    return this.item !== null && this.resourceSeekable
  }

  get bitrateKbps(): BitrateKbps | null {
    return this.item === null ? null : this.sourceBitrateKbps
  }

  begin(item: QueueItem, offsetMs: number): PlaybackStart {
    const replacingSameItem = this.item?.id === item.id
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    this.generation += 1
    this.item = item
    this.basePositionMs = offsetMs
    this.startedAtMs = 0
    this.startedAt = this.clock.now().toISOString()
    this.paused = false
    this.resource?.dispose()
    this.resource = null
    if (!replacingSameItem) {
      this.media = null
      this.sourceBitrateKbps = null
      this.resourceSeekable = false
    }
    return { generation: this.generation, item, offsetMs, signal: abort.signal }
  }

  async prepare(start: PlaybackStart): Promise<AudioResource | null> {
    const preload = this.preloaded?.trackId === start.item.track.id ? this.preloaded : null
    if (preload !== null) this.preloaded = null
    const preloaded = preload === null ? null : await preload.result
    const media =
      this.media ??
      (preloaded?.kind === "ready"
        ? preloaded.media
        : await this.source.resolve(start.item.track, start.signal))
    if (start.offsetMs > 0 && !media.seekable) {
      throw new RangeError("Media does not support seeking")
    }
    const resource = await this.resourceFactory.create(media, start.offsetMs, start.signal)
    if (!this.isActive(start.generation)) {
      resource.dispose()
      return null
    }
    this.media = media
    this.resource = resource
    this.sourceBitrateKbps = media.bitrateKbps
    this.resourceSeekable = media.seekable
    return resource
  }

  isActive(generation: number): boolean {
    return generation === this.generation && this.item !== null
  }

  markStarted(generation: number): void {
    if (!this.isActive(generation) || this.paused || this.startedAtMs !== 0) return
    this.startedAtMs = this.clock.now().getTime()
  }

  preload(track: QueueItem["track"]): void {
    if (this.preloaded?.trackId === track.id) return
    this.preloaded?.abort.abort()
    const abort = new AbortController()
    this.preloaded = {
      trackId: track.id,
      abort,
      result: this.source.resolve(track, abort.signal).then(
        (media) => ({ kind: "ready", media }),
        () => ({ kind: "failed" }),
      ),
    }
  }

  cancelPreload(): void {
    this.preloaded?.abort.abort()
    this.preloaded = null
  }

  pause(): void {
    this.basePositionMs = this.position()
    this.paused = true
  }

  resume(): void {
    this.startedAtMs = this.clock.now().getTime()
    this.paused = false
  }

  position(): number {
    if (this.item === null) return 0
    const elapsed =
      this.paused || this.startedAtMs === 0 ? 0 : this.clock.now().getTime() - this.startedAtMs
    return Math.min(this.item.track.durationMs, this.basePositionMs + elapsed)
  }

  invalidate(): void {
    this.generation += 1
  }

  reset(): void {
    this.resource?.dispose()
    this.abort?.abort()
    this.abort = null
    this.resource = null
    this.sourceBitrateKbps = null
    this.resourceSeekable = false
    this.media = null
    this.item = null
    this.basePositionMs = 0
    this.paused = false
  }
}
