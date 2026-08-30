import type { QueueItem } from "@discord-music/contracts"

import type { Clock } from "../domain/clock.js"
import type { MusicSource } from "../media/types.js"
import type { AudioResource, AudioResourceFactory } from "./ports.js"

type PlaybackStart = {
  readonly generation: number
  readonly item: QueueItem
  readonly offsetMs: number
  readonly signal: AbortSignal
}

export class PlaybackSession {
  private item: QueueItem | null = null
  private resource: AudioResource | null = null
  private abort: AbortController | null = null
  private basePositionMs = 0
  private startedAtMs = 0
  private paused = false
  private generation = 0
  private startedAt = ""

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

  begin(item: QueueItem, offsetMs: number): PlaybackStart {
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    this.generation += 1
    this.item = item
    this.basePositionMs = offsetMs
    this.startedAtMs = this.clock.now().getTime()
    this.startedAt = this.clock.now().toISOString()
    this.paused = false
    this.resource?.dispose()
    this.resource = null
    return { generation: this.generation, item, offsetMs, signal: abort.signal }
  }

  async prepare(start: PlaybackStart): Promise<AudioResource | null> {
    const media = await this.source.resolve(start.item.track, start.signal)
    if (start.offsetMs > 0 && !media.seekable) {
      throw new RangeError("Media does not support seeking")
    }
    const resource = await this.resourceFactory.create(media, start.offsetMs, start.signal)
    if (!this.isActive(start.generation)) {
      resource.dispose()
      return null
    }
    this.resource = resource
    return resource
  }

  isActive(generation: number): boolean {
    return generation === this.generation && this.item !== null
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
    const elapsed = this.paused ? 0 : this.clock.now().getTime() - this.startedAtMs
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
    this.item = null
    this.basePositionMs = 0
    this.paused = false
  }
}
