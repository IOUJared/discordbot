import { spawn } from "node:child_process"
import { type AudioResource, createAudioResource, StreamType } from "@discordjs/voice"

import type { PlayableMedia, RemotePlayableMedia } from "../media/types.js"
import type { AudioResourceFactory, AudioResource as PlayerAudioResource } from "../player/ports.js"
import { bufferDirectStream, openDirectStream, openSeekableMediaProxy } from "./direct-stream.js"

/** Tracks at least this long are pulled through the loopback bridge. */
export const bufferedAfterMs = 5 * 60_000

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
  const input = media.kind === "local" ? media.url : "pipe:0"
  args.push(
    "-i",
    inputOverride ?? input,
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
    durationMs?: number,
  ): Promise<PlayerAudioResource> {
    // Long tracks are throttled hard enough that a bare node stream underruns the
    // 20 ms packet loop, so ffmpeg pulls them through the loopback bridge and
    // reads ahead. Short tracks keep the direct passthrough: it avoids a
    // re-encode, which is audible as micro-stutter on already-encoded audio.
    const useBridge = durationMs === undefined || durationMs >= bufferedAfterMs
    if (media.kind === "remote" && useBridge) {
      return this.createBridged(media, offsetMs, signal)
    }
    return this.createDirect(media, offsetMs, signal)
  }

  private async createBridged(
    media: RemotePlayableMedia,
    offsetMs: number,
    signal?: AbortSignal,
  ): Promise<PlayerAudioResource> {
    const seekProxy = await openSeekableMediaProxy(media, signal === undefined ? {} : { signal })
    const child = spawn("ffmpeg", [...ffmpegArgs(media, offsetMs, seekProxy.url)], {
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
        seekProxy.close()
        if (child.exitCode === null) child.kill("SIGKILL")
      },
    )
  }

  private async createDirect(
    media: PlayableMedia,
    offsetMs: number,
    signal?: AbortSignal,
  ): Promise<PlayerAudioResource> {
    if (
      offsetMs === 0 &&
      media.kind === "remote" &&
      media.container === "webm" &&
      media.codec === "opus"
    ) {
      const stream = await bufferDirectStream(
        await openDirectStream(media, signal === undefined ? {} : { signal }),
      )
      return new DiscordVoiceResource(
        createAudioResource(stream, { inputType: StreamType.WebmOpus, inlineVolume: true }),
        () => stream.destroy(),
      )
    }
    const seekProxy =
      media.kind === "remote" && offsetMs > 0
        ? await openSeekableMediaProxy(media, signal === undefined ? {} : { signal })
        : undefined
    const remoteStream =
      media.kind === "remote" && seekProxy === undefined
        ? await bufferDirectStream(
            await openDirectStream(media, signal === undefined ? {} : { signal }),
          )
        : undefined
    const child = spawn("ffmpeg", [...ffmpegArgs(media, offsetMs, seekProxy?.url)], {
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
        seekProxy?.close()
        if (child.exitCode === null) child.kill("SIGKILL")
      },
    )
  }
}
