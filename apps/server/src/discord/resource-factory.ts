import { spawn } from "node:child_process"
import { type AudioResource, createAudioResource, StreamType } from "@discordjs/voice"

import type { PlayableMedia } from "../media/types.js"
import type { AudioResourceFactory, AudioResource as PlayerAudioResource } from "../player/ports.js"
import { bufferDirectStream, openDirectStream } from "./direct-stream.js"

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
  let input: string
  switch (media.kind) {
    case "local":
      input = media.url
      break
    case "remote":
      input = "pipe:0"
      break
    default: {
      const unreachable: never = media
      throw new TypeError(`Unsupported media kind: ${String(unreachable)}`)
    }
  }
  args.push(
    "-i",
    input,
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
    if (media.kind === "remote" && media.container === "webm" && media.codec === "opus") {
      const stream = await bufferDirectStream(
        await openDirectStream(media, signal === undefined ? {} : { signal }),
      )
      return new DiscordVoiceResource(
        createAudioResource(stream, { inputType: StreamType.WebmOpus, inlineVolume: true }),
        () => stream.destroy(),
      )
    }
    const remoteStream =
      media.kind === "remote"
        ? await bufferDirectStream(
            await openDirectStream(media, signal === undefined ? {} : { signal }),
          )
        : undefined
    const child = spawn("ffmpeg", [...ffmpegArgs(media, offsetMs)], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
    if (remoteStream === undefined) child.stdin.end()
    else remoteStream.pipe(child.stdin)
    const abort = () => child.kill("SIGKILL")
    signal?.addEventListener("abort", abort, { once: true })
    const removeAbortListener = () => signal?.removeEventListener("abort", abort)
    child.once("exit", removeAbortListener)
    return new DiscordVoiceResource(
      createAudioResource(child.stdout, { inputType: StreamType.OggOpus, inlineVolume: true }),
      () => {
        removeAbortListener()
        remoteStream?.destroy()
        if (child.exitCode === null) child.kill("SIGKILL")
      },
    )
  }
}
