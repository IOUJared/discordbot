import { describe, expect, it } from "vitest"

import { ffmpegArgs } from "../../src/discord/resource-factory.js"
import { RemoteMediaUrlSchema } from "../../src/media/media-url-policy.js"
import { ExternalProcessError, nodeProcessExecutor } from "../../src/media/process-executor.js"

describe("external media processes", () => {
  it("cancels a hung subprocess with AbortSignal", async () => {
    // Given
    const controller = new AbortController()
    const pending = nodeProcessExecutor.run({
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 10_000)"],
      timeoutMs: 20_000,
      signal: controller.signal,
    })

    // When
    controller.abort()

    // Then
    await expect(pending).rejects.toBeInstanceOf(ExternalProcessError)
  })

  it("keeps a remote URL out of FFmpeg arguments", () => {
    // Given
    const url = RemoteMediaUrlSchema.parse(
      "https://rr1---sn-a5mekn7z.googlevideo.com/videoplayback?id=abc",
    )

    // When
    const args = ffmpegArgs(
      {
        kind: "remote",
        url,
        headers: { "User-Agent": "agent" },
        container: "m4a",
        codec: "aac",
        bitrateKbps: null,
        seekable: true,
      },
      1_500,
    )

    // Then
    expect(args).not.toContain(url)
    expect(args).toContain("pipe:0")
  })

  it("uses an authorized loopback bridge for a remote seek", () => {
    const mediaUrl = RemoteMediaUrlSchema.parse(
      "https://rr1---sn-a5mekn7z.googlevideo.com/videoplayback?id=abc",
    )

    const args = ffmpegArgs(
      {
        kind: "remote",
        url: mediaUrl,
        headers: {},
        container: "webm",
        codec: "opus",
        bitrateKbps: null,
        seekable: true,
      },
      45_000,
      "http://127.0.0.1:43210/media",
    )

    expect(args).toContain("45.000")
    expect(args).toContain("http://127.0.0.1:43210/media")
    expect(args).not.toContain(mediaUrl)
  })
})
