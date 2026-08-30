import { describe, expect, it } from "vitest"

import { ffmpegArgs } from "../../src/discord/resource-factory.js"
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

  it("keeps URL and header injection payloads in their original arguments", () => {
    // Given
    const url = "https://media.example/audio?x=$(touch /tmp/nope);id"
    const authorization = "Bearer x; $(id)"

    // When
    const args = ffmpegArgs(
      {
        url,
        headers: { Authorization: authorization },
        container: "m4a",
        codec: "aac",
        seekable: true,
      },
      1_500,
    )

    // Then
    expect(args).toContain(url)
    expect(args).toContain(`Authorization: ${authorization}\r\n`)
  })
})
