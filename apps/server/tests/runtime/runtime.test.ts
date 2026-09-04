import { once } from "node:events"
import { createServer } from "node:http"

import { describe, expect, it } from "vitest"

import type { ParsedServerConfig } from "../../src/config.js"
import {
  assertDependencies,
  checkDependencies,
  MissingDependencyError,
} from "../../src/runtime/dependencies.js"
import { createProductionMedia } from "../../src/runtime/production.js"
import { createShutdown } from "../../src/runtime/shutdown.js"

describe("server runtime", () => {
  it("Given installed media binaries When probed Then each receives its supported version flag", async () => {
    const invocations: string[] = []

    const result = await checkDependencies(async (file, args) => {
      invocations.push(`${file} ${args.join(" ")}`)
    })

    expect(result).toEqual({ ffmpeg: true, ytDlp: true })
    expect(invocations.sort()).toEqual(["ffmpeg -version", "yt-dlp --version"])
  })

  it("Given a missing media dependency When probed Then degraded availability is reported", async () => {
    const result = await checkDependencies(async (file) => {
      if (file === "yt-dlp") throw new Error("missing")
    })

    expect(result).toEqual({ ffmpeg: true, ytDlp: false })
  })

  it("Given missing production media binaries When startup asserts them Then exact commands are reported", () => {
    expect(() => assertDependencies({ ffmpeg: false, ytDlp: false })).toThrowError(
      new MissingDependencyError(["ffmpeg", "yt-dlp"]),
    )
  })

  it("Given repeated shutdown calls When executed Then each resource closes once", async () => {
    const closed: string[] = []
    const shutdown = createShutdown([
      {
        close: () => {
          closed.push("player")
        },
      },
      {
        close: async () => {
          closed.push("database")
        },
      },
    ])

    await Promise.all([shutdown(), shutdown(), shutdown()])

    expect(closed).toEqual(["player", "database"])
  })

  it("Given Rust production mode When search runs Then the bound sidecar client serves it", async () => {
    // Given: the production composition points at a strict fake sidecar HTTP boundary.
    const sidecar = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { "content-type": "application/json" })
      if (request.url === "/v1/search") {
        response.end(
          JSON.stringify({
            version: 1,
            results: [
              {
                track: {
                  id: "runtime-track",
                  provider: "youtube",
                  title: "Runtime",
                  artist: "Artist",
                  url: "https://www.youtube.com/watch?v=runtime-track",
                  durationMs: 60_000,
                  artworkUrl: "https://img.youtube.com/runtime-track.jpg",
                },
                score: 1,
                bitrateKbps: null,
              },
            ],
          }),
        )
        return
      }
      response.end(
        JSON.stringify({
          version: 1,
          media: {
            kind: "remote",
            url: "https://rr1---fixture.googlevideo.com/videoplayback?id=runtime",
            headers: {},
            container: "webm",
            codec: "opus",
            bitrateKbps: 128,
            seekable: true,
          },
        }),
      )
    })
    sidecar.listen(0, "127.0.0.1")
    await once(sidecar, "listening")
    const address = sidecar.address()
    if (address === null || typeof address === "string") throw new TypeError("Expected address")
    const config: ParsedServerConfig = {
      discordToken: "token",
      discordClientId: "client",
      discordClientSecret: "secret",
      guildId: "guild",
      discordOwnerId: "owner",
      authorizedUserIds: new Set(["owner"]),
      frontendUrl: "https://music.example.com",
      frontendOrigin: "https://music.example.com",
      publicUrl: "https://api.example.com",
      databasePath: ":memory:",
      host: "127.0.0.1",
      port: 0,
      voiceIdleTimeoutMs: 300_000,
      logLevel: "silent",
      discordApiUrl: "https://discord.com/api/v10",
      mediaSidecar: { mode: "rust", url: `http://127.0.0.1:${address.port}` },
    }
    const media = createProductionMedia(config, () => undefined)

    // When: production dispatches a search through the configured Rust seam.
    try {
      const results = await media.source.search("runtime")

      // Then: the strict response crosses the bound class adapter without an internal error.
      expect(results.at(0)?.track.id).toBe("runtime-track")
    } finally {
      await media.rollout.close()
      sidecar.closeAllConnections()
      sidecar.close()
      await once(sidecar, "close")
    }
  })
})
