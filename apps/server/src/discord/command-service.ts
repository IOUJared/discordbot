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
import type { CommandContext, CommandResult, CommandService } from "./commands.js"

const querySchema = z.object({ query: z.string().trim().min(1).max(512) })
const queueIdSchema = z.object({ id: QueueItemIdSchema })
const loopSchema = z.object({ mode: LoopModeSchema })
const volumeSchema = z.object({ volume: VolumeSchema })
const seekSchema = z.object({ seconds: z.number().int().nonnegative() })

function assertNever(value: never): never {
  throw new TypeError(`Unsupported command: ${String(value)}`)
}

export class PlayerCommandService implements CommandService {
  constructor(private readonly player: PlayerControls) {}

  async execute(context: CommandContext): Promise<CommandResult> {
    switch (context.name) {
      case "play": {
        if (context.voiceChannelId === null) return { kind: "invalid", message: "Join voice first" }
        const { query } = querySchema.parse(context.options)
        await this.player.play(query, context.userId, context.voiceChannelId)
        return { kind: "ok", message: "Queued" }
      }
      case "pause":
        return { kind: "ok", message: this.player.pause() ? "Paused" : "Already paused" }
      case "resume":
        return { kind: "ok", message: this.player.resume() ? "Resumed" : "Already playing" }
      case "skip":
        await this.player.skip()
        return { kind: "ok", message: "Skipped" }
      case "stop":
        this.player.stop()
        return { kind: "ok", message: "Stopped" }
      case "queue":
        return {
          kind: "ok",
          message: this.player
            .snapshot()
            .queue.map(({ track }) => track.title)
            .join("\n"),
        }
      case "nowplaying":
        return {
          kind: "ok",
          message: this.player.snapshot().currentItem?.track.title ?? "Nothing playing",
        }
      case "remove": {
        const { id } = queueIdSchema.parse(context.options)
        this.player.remove(id)
        return { kind: "ok", message: "Removed" }
      }
      case "clear":
        this.player.clear()
        return { kind: "ok", message: "Cleared" }
      case "shuffle":
        this.player.shuffle()
        return { kind: "ok", message: "Shuffled" }
      case "loop": {
        const { mode } = loopSchema.parse(context.options)
        this.player.setLoop(mode)
        return { kind: "ok", message: `Loop ${mode}` }
      }
      case "volume": {
        const { volume } = volumeSchema.parse(context.options)
        this.player.setVolume(volume)
        return { kind: "ok", message: `Volume ${volume}` }
      }
      case "seek": {
        const { seconds } = seekSchema.parse(context.options)
        await this.player.seek(seconds * 1_000)
        return { kind: "ok", message: "Seeked" }
      }
      case "join":
        if (context.voiceChannelId === null) return { kind: "invalid", message: "Join voice first" }
        await this.player.join(context.voiceChannelId)
        return { kind: "ok", message: "Joined" }
      case "leave":
        await this.player.leave()
        return { kind: "ok", message: "Left" }
      default:
        return assertNever(context.name)
    }
  }
}

export interface PlayerControls {
  play(query: string, requestedBy: UserId, channelId: ChannelId): Promise<QueueItem>
  enqueue(track: Track, requestedBy: UserId): Promise<QueueItem>
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
