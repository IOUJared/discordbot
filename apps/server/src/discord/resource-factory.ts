import { spawn } from "node:child_process"
import { type AudioResource, createAudioResource, demuxProbe, StreamType } from "@discordjs/voice"

import type { PlayableMedia } from "../media/types.js"
import type { AudioResourceFactory, AudioResource as PlayerAudioResource } from "../player/ports.js"
import { openDirectStream } from "./direct-stream.js"

export class DiscordVoiceResource implements PlayerAudioResource {
  readonly audioResource: AudioResource<null>

  constructor(
    audioResource: AudioResource<null>,
    private readonly cleanup: () => void,
  ) {
    this.audioResource = audioResource
  }

  dispose(): void {
    this.cleanup()
  }
}

export function ffmpegArgs(media: PlayableMedia, offsetMs: number): readonly string[] {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"]
  if (offsetMs > 0) args.push("-ss", (offsetMs / 1_000).toFixed(3))
  const headerLines = Object.entries(media.headers).map(([name, value]) => `${name}: ${value}`)
  if (headerLines.length > 0) args.push("-headers", `${headerLines.join("\r\n")}\r\n`)
  args.push(
    "-i",
    media.url,
    "-vn",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "libopus",
    "-f",
    "opus",
    "pipe:1",
  )
  return args
}

export class DiscordAudioResourceFactory implements AudioResourceFactory {
  async create(
    media: PlayableMedia,
    offsetMs: number,
    signal?: AbortSignal,
  ): Promise<PlayerAudioResource> {
    if (media.container === "webm" && media.codec === "opus") {
      try {
        const stream = await openDirectStream(media, signal)
        const probe = await demuxProbe(stream)
        return new DiscordVoiceResource(
          createAudioResource(probe.stream, { inputType: probe.type, inlineVolume: true }),
          () => probe.stream.destroy(),
        )
      } catch (error) {
        if (!(error instanceof Error)) throw error
      }
    }
    const child = spawn("ffmpeg", [...ffmpegArgs(media, offsetMs)], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const abort = () => child.kill("SIGKILL")
    signal?.addEventListener("abort", abort, { once: true })
    const removeAbortListener = () => signal?.removeEventListener("abort", abort)
    child.once("exit", removeAbortListener)
    return new DiscordVoiceResource(
      createAudioResource(child.stdout, { inputType: StreamType.OggOpus, inlineVolume: true }),
      () => {
        removeAbortListener()
        if (child.exitCode === null) child.kill("SIGKILL")
      },
    )
  }
}
