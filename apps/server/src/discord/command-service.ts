import type {
  ChannelId,
  LoopMode,
  PlayerSnapshot,
  QueueItem,
  QueueItemId,
  Track,
  UserId,
  Volume,
} from "@discord-music/contracts"
import { LoopModeSchema, QueueItemIdSchema, VolumeSchema } from "@discord-music/contracts"
import { z } from "zod"
import type { RadioSource } from "../media/types.js"
import type { CommandContext, CommandResult, CommandService } from "./commands.js"

const querySchema = z.object({ query: z.string().trim().min(1).max(512) })
const radioSchema = z.object({ genre: z.string().trim().min(2).max(80) })
const queueIdSchema = z.object({ id: QueueItemIdSchema })
const loopSchema = z.object({ mode: LoopModeSchema })
const volumeSchema = z.object({ volume: VolumeSchema })
const seekSchema = z.object({ seconds: z.number().int().nonnegative() })

function assertNever(value: never): never {
  throw new TypeError(`Unsupported command: ${String(value)}`)
}

export class PlayerCommandService implements CommandService {
  constructor(
    private readonly player: PlayerControls,
    private readonly radioSource: RadioSource,
  ) {}

  async execute(context: CommandContext): Promise<CommandResult> {
    switch (context.name) {
      case "play": {
        if (context.voiceChannelId === null) return { kind: "invalid", message: "Join voice first" }
        const { query } = querySchema.parse(context.options)
        const item = await this.player.play(query, context.userId, context.voiceChannelId)
        return { kind: "ok", message: "Now playing", track: item.track }
      }
      case "radio": {
        if (context.voiceChannelId === null) return { kind: "invalid", message: "Join voice first" }
        const { genre } = radioSchema.parse(context.options)
        const playlist = await this.radioSource.radio(genre)
        await this.player.join(context.voiceChannelId)
        await this.player.enqueueMany(playlist.tracks, context.userId)
        await this.player.startIfIdle()
        return {
          kind: "ok",
          message: `Queued ${playlist.tracks.length} tracks from ${playlist.title} for ${genre} radio.`,
        }
      }
      case "pause":
        return {
          kind: "ok",
          message: this.player.pause() ? "Playback is paused." : "Playback was already paused.",
        }
      case "resume":
        return {
          kind: "ok",
          message: this.player.resume() ? "Playback has resumed." : "Playback is already running.",
        }
      case "skip": {
        await this.player.skip()
        const current = this.player.snapshot().currentItem
        return current === null
          ? { kind: "ok", message: "Skipped. The queue is now empty." }
          : { kind: "ok", message: "Now playing", track: current.track }
      }
      case "stop":
        this.player.stop()
        return { kind: "ok", message: "Playback stopped and the queue was cleared." }
      case "queue": {
        const queue = this.player.snapshot().queue
        return {
          kind: "ok",
          message:
            queue.length === 0
              ? "The queue is empty."
              : queue.map(({ track }, index) => `${index + 1}. ${track.title}`).join("\n"),
        }
      }
      case "nowplaying": {
        const current = this.player.snapshot().currentItem
        return current === null
          ? { kind: "ok", message: "Nothing is currently playing." }
          : { kind: "ok", message: "Now playing", track: current.track }
      }
      case "remove": {
        const { id } = queueIdSchema.parse(context.options)
        const removed = this.player.remove(id)
        return { kind: "ok", message: `Removed ${removed.track.title} from the queue.` }
      }
      case "clear":
        this.player.clear()
        return { kind: "ok", message: "All queued tracks were removed." }
      case "shuffle":
        this.player.shuffle()
        return { kind: "ok", message: "The remaining queue was shuffled." }
      case "loop": {
        const { mode } = loopSchema.parse(context.options)
        this.player.setLoop(mode)
        return { kind: "ok", message: `Loop mode is now ${mode}.` }
      }
      case "volume": {
        const { volume } = volumeSchema.parse(context.options)
        this.player.setVolume(volume)
        return { kind: "ok", message: `Volume is now ${volume}%.` }
      }
      case "seek": {
        const { seconds } = seekSchema.parse(context.options)
        await this.player.seek(seconds * 1_000)
        const minutes = Math.floor(seconds / 60)
        const remainingSeconds = String(seconds % 60).padStart(2, "0")
        return { kind: "ok", message: `Playback moved to ${minutes}:${remainingSeconds}.` }
      }
      case "join":
        if (context.voiceChannelId === null) return { kind: "invalid", message: "Join voice first" }
        await this.player.join(context.voiceChannelId)
        return { kind: "ok", message: "Connected to your voice channel." }
      case "leave":
        await this.player.leave()
        return { kind: "ok", message: "Left the voice channel and stopped playback." }
      default:
        return assertNever(context.name)
    }
  }
}

export interface PlayerControls {
  play(query: string, requestedBy: UserId, channelId: ChannelId): Promise<QueueItem>
  enqueue(track: Track, requestedBy: UserId): Promise<QueueItem>
  enqueueMany(tracks: readonly Track[], requestedBy: UserId): Promise<readonly QueueItem[]>
  startIfIdle(): Promise<void>
  pause(): boolean
  resume(): boolean
  skip(): Promise<void>
  stop(): void
  snapshot(): PlayerSnapshot
  remove(id: QueueItemId): QueueItem
  clear(): void
  shuffle(): void
  setLoop(mode: LoopMode): void
  setVolume(volume: Volume): void
  seek(offsetMs: number): Promise<void>
  join(channelId: ChannelId): Promise<void>
  leave(): Promise<void>
}
