import { spawn } from "node:child_process"
import { type AudioResource, createAudioResource, StreamType } from "@discordjs/voice"

import type { PlayableMedia } from "../media/types.js"
import type { AudioResourceFactory, AudioResource as PlayerAudioResource } from "../player/ports.js"
import { openSeekableMediaProxy } from "./direct-stream.js"

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

export function ffmpegArgs(
  media: PlayableMedia,
  offsetMs: number,
  inputOverride?: string,
): readonly string[] {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"]
  if (offsetMs > 0) args.push("-ss", (offsetMs / 1_000).toFixed(3))
  if (media.kind === "remote" && inputOverride === undefined) {
    throw new TypeError("Remote media requires a proxied input")
  }
  args.push(
    "-i",
    inputOverride ?? media.url,
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
    // Remote audio is always pulled by ffmpeg through the local proxy instead of
    // handing a bare node HTTP stream to the 20 ms packet loop: on long, throttled
    // YouTube downloads the stream underruns, the player misses five frames and
    // reports the track as finished after about a second. ffmpeg reads ahead and
    // buffers, so short CDN stalls no longer end playback.
    const seekProxy =
      media.kind === "remote"
        ? await openSeekableMediaProxy(media, signal === undefined ? {} : { signal })
        : undefined
    const child = spawn("ffmpeg", [...ffmpegArgs(media, offsetMs, seekProxy?.url)], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdin.end()
    const abort = () => child.kill("SIGKILL")
    signal?.addEventListener("abort", abort, { once: true })
    const removeAbortListener = () => signal?.removeEventListener("abort", abort)
    child.once("exit", removeAbortListener)
    return new DiscordVoiceResource(
      createAudioResource(child.stdout, { inputType: StreamType.OggOpus, inlineVolume: true }),
      () => {
        removeAbortListener()
        seekProxy?.close()
        if (child.exitCode === null) child.kill("SIGKILL")
      },
    )
  }
}
