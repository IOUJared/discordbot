import { type ChildProcess, spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { createServer as createNetServer } from "node:net"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

import { TrackSchema } from "@discord-music/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { parseYouTubeSearchResponse } from "../../src/media/youtube-search.js"
import { YouTubeSidecarClient } from "../../src/media/youtube-sidecar-client.js"

const repositoryRoot = join(import.meta.dirname, "../../../..")
const fixtureRoot = join(repositoryRoot, "spec/media-sidecar/v1")
const harnessPath = join(
  repositoryRoot,
  "apps/media-sidecar/target/release/media-sidecar-test-harness",
)
const responseSchema = z.object({
  version: z.literal(1),
  results: z.array(
    z.object({
      track: TrackSchema.extend({ artworkUrl: z.url() }),
      score: z.number().min(0).max(1),
      bitrateKbps: z.null(),
    }),
  ),
})
const manifestSchema = z.object({
  raw: z.array(
    z.object({
      path: z.string(),
      sourceKind: z.string(),
      expected: z.object({ outcome: z.string(), fixture: z.string().optional() }),
    }),
  ),
})
const sharedCases = manifestSchema
  .parse(JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8")))
  .raw.filter((item) => item.sourceKind === "innertube" && item.expected.outcome === "response")

let upstream: Server | undefined
let harness: ChildProcess | undefined
let client: YouTubeSidecarClient | undefined
let upstreamBody = ""

async function freePort(): Promise<number> {
  const server = createNetServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("Expected TCP address")
  server.close()
  await once(server, "close")
  return address.port
}

async function waitForHealth(activeClient: YouTubeSidecarClient): Promise<void> {
  const deadline = performance.now() + 3_000
  while (performance.now() < deadline) {
    try {
      if ((await activeClient.health()).status === "ok") return
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new TypeError("Rust harness did not become ready")
}

function boundaryResponse(): unknown {
  const renderer = (id: string, title: string, thumbnails: unknown) => ({
    videoRenderer: {
      videoId: id,
      title: { runs: [{ text: title }] },
      ownerText: { runs: [{ text: "Artist" }] },
      lengthText: { simpleText: "1:00" },
      thumbnail: { thumbnails },
    },
  })
  return {
    contents: [
      renderer("astral-513-utf16", `${"😀".repeat(256)}a`, [{ url: "ftp://images.example/cover" }]),
      renderer("combining-512-code-points", "e\u0301".repeat(256), [
        { url: "data:text/plain,cover" },
      ]),
      renderer("astral-513-code-points", "😀".repeat(513), [
        { url: "https://images.example/cover" },
      ]),
      renderer("relative-before-valid", "Title", [
        { url: "/relative" },
        { url: "https://images.example/cover" },
      ]),
      renderer("malformed-before-valid", "Title", [
        { url: "not a url" },
        { url: "https://images.example/cover" },
      ]),
    ],
  }
}

const behavioralContract = existsSync(harnessPath) ? describe : describe.skip

behavioralContract("Rust and retained Node search behavioral contract", () => {
  beforeAll(async () => {
    upstream = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { "content-type": "application/json" })
      response.end(upstreamBody)
    })
    upstream.listen(0, "127.0.0.1")
    await once(upstream, "listening")
    const address = upstream.address()
    if (address === null || typeof address === "string")
      throw new TypeError("Expected upstream address")
    const port = await freePort()
    harness = spawn(harnessPath, [], {
      env: {
        ...process.env,
        SIDECAR_HOST: "127.0.0.1",
        SIDECAR_PORT: String(port),
        SIDECAR_TEST_UPSTREAM: `http://127.0.0.1:${address.port}/youtubei/v1/search`,
      },
      stdio: "ignore",
    })
    client = new YouTubeSidecarClient({ baseUrl: `http://127.0.0.1:${port}` })
    await waitForHealth(client)
  })

  afterAll(async () => {
    await client?.close()
    if (harness !== undefined) {
      harness.kill("SIGTERM")
      await once(harness, "exit")
    }
    if (upstream !== undefined) {
      upstream.closeAllConnections()
      upstream.close()
      await once(upstream, "close")
    }
  })

  it("normalizes every shared Innertube fixture identically", async () => {
    // Given: hash-locked raw fixtures and their exact public response fixtures.
    const activeClient = client
    if (activeClient === undefined) throw new TypeError("Rust client is unavailable")
    for (const item of sharedCases) {
      const raw: unknown = JSON.parse(readFileSync(join(fixtureRoot, item.path), "utf8"))
      const fixture = item.expected.fixture
      if (fixture === undefined) throw new TypeError("Expected response fixture is unavailable")
      const expected = responseSchema.parse(
        JSON.parse(readFileSync(join(fixtureRoot, fixture), "utf8")),
      ).results

      // When: Node parses raw JSON directly and Rust parses those exact bytes over the real HTTP boundary.
      upstreamBody = JSON.stringify(raw)
      expect(parseYouTubeSearchResponse(raw)).toEqual(expected)
      expect(await activeClient.search(`contract-${item.path}`)).toEqual(expected)
    }
  })

  it("matches the adversarial code-point and thumbnail candidate matrix", async () => {
    // Given: one bounded response with astral, combining, ftp/data, relative, and malformed candidates.
    const activeClient = client
    if (activeClient === undefined) throw new TypeError("Rust client is unavailable")
    const raw = boundaryResponse()
    const expected = parseYouTubeSearchResponse(raw)

    // When: both parsers process exactly the same in-memory fixture bytes.
    upstreamBody = JSON.stringify(raw)
    const rust = await activeClient.search("contract-boundary")

    // Then: they emit the same normalized public results, including scores and artwork metadata schemes.
    expect(expected.map(({ track, score }) => [track.id, track.artworkUrl, score])).toEqual([
      ["astral-513-utf16", "ftp://images.example/cover", 1],
      ["combining-512-code-points", "data:text/plain,cover", 0.9],
    ])
    expect(rust).toEqual(expected)

    const nullThumbnail = {
      contents: [
        {
          videoRenderer: {
            videoId: "null-thumbnail",
            title: { runs: [{ text: "Title" }] },
            ownerText: { runs: [{ text: "Artist" }] },
            lengthText: { simpleText: "1:00" },
            thumbnail: { thumbnails: [{ url: null }] },
          },
        },
      ],
    }
    upstreamBody = JSON.stringify(nullThumbnail)
    expect(parseYouTubeSearchResponse(nullThumbnail)).toEqual([])
    expect(await activeClient.search("contract-null-thumbnail")).toEqual([])
  })
})
