import { type ChildProcess, spawn } from "node:child_process"
import { once } from "node:events"
import { createServer, type Server } from "node:http"
import { createServer as createNetServer } from "node:net"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

import type { SearchResult } from "@discord-music/contracts"
import { afterAll, beforeAll, expect, it } from "vitest"

import { YouTubeMusicSource } from "../../src/media/youtube.js"
import { YouTubeSidecarClient } from "../../src/media/youtube-sidecar-client.js"
import { parseSidecarSearch } from "../../src/media/youtube-sidecar-observation.js"

const repositoryRoot = join(import.meta.dirname, "../../../..")
const expectedResults: readonly SearchResult[] = parseSidecarSearch({
  version: 1,
  results: [
    {
      track: {
        id: "valid-ordinal-1",
        provider: "youtube",
        title: "Ordinal Song",
        artist: "Ordinal Artist",
        url: "https://www.youtube.com/watch?v=valid-ordinal-1",
        durationMs: 62_000,
        artworkUrl: "https://i.ytimg.com/vi/valid-ordinal-1/hqdefault.jpg",
      },
      score: 0.9,
      bitrateKbps: null,
    },
  ],
})

let upstream: Server
let upstreamCalls = 0
let harness: ChildProcess
let client: YouTubeSidecarClient
let source: YouTubeMusicSource
const rustEvents: unknown[] = []

async function freePort(): Promise<number> {
  const server = createNetServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("Expected TCP address")
  const port = address.port
  server.close()
  await once(server, "close")
  return port
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = performance.now() + 3_000
  while (performance.now() < deadline) {
    try {
      const health = await client.health()
      if (health.status === "ok") return
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`Harness failed to become ready at ${baseUrl}`)
}

function rustEventRecorder(): (chunk: Buffer) => void {
  let pending = ""
  return (chunk) => {
    const lines = `${pending}${chunk.toString("utf8")}`.split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) {
      if (line === "") continue
      try {
        const outer: unknown = JSON.parse(line)
        if (
          typeof outer === "object" &&
          outer !== null &&
          "fields" in outer &&
          typeof outer.fields === "object" &&
          outer.fields !== null &&
          "observation" in outer.fields &&
          typeof outer.fields.observation === "string"
        ) {
          rustEvents.push(JSON.parse(outer.fields.observation))
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
  }
}

function p95(samples: readonly number[]): number {
  const ordered = samples.toSorted((left, right) => left - right)
  const index = Math.ceil(ordered.length * 0.95) - 1
  const value = ordered.at(index)
  if (value === undefined) throw new RangeError("No benchmark samples")
  return value
}

async function timedSearch(query: string): Promise<number> {
  const started = performance.now()
  expect(await source.search(query)).toEqual(expectedResults)
  return performance.now() - started
}

beforeAll(async () => {
  upstream = createServer((request, reply) => {
    upstreamCalls += 1
    request.resume()
    reply.writeHead(200, { "content-type": "application/json" })
    reply.end(
      JSON.stringify({
        contents: [
          { videoRenderer: { videoId: 7, title: { runs: [{ text: "Malformed" }] } } },
          {
            videoRenderer: {
              videoId: "valid-ordinal-1",
              title: { runs: [{ text: "Ordinal Song" }] },
              ownerText: { runs: [{ text: "Ordinal Artist" }] },
              lengthText: { simpleText: "1:02" },
              thumbnail: {
                thumbnails: [{ url: "https://i.ytimg.com/vi/valid-ordinal-1/hqdefault.jpg" }],
              },
            },
          },
        ],
      }),
    )
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const upstreamAddress = upstream.address()
  if (upstreamAddress === null || typeof upstreamAddress === "string")
    throw new TypeError("Expected upstream TCP address")
  const sidecarPort = await freePort()
  harness = spawn(
    join(repositoryRoot, "apps/media-sidecar/target/release/media-sidecar-test-harness"),
    [],
    {
      env: {
        ...process.env,
        SIDECAR_HOST: "127.0.0.1",
        SIDECAR_PORT: String(sidecarPort),
        SIDECAR_TEST_UPSTREAM: `http://127.0.0.1:${upstreamAddress.port}/youtubei/v1/search`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  harness.stdout?.on("data", rustEventRecorder())
  harness.stderr?.on("data", rustEventRecorder())
  const baseUrl = `http://127.0.0.1:${sidecarPort}`
  client = new YouTubeSidecarClient({ baseUrl })
  source = new YouTubeMusicSource(undefined, undefined, {
    searchClient: client,
    searchCacheCapacity: 300,
    preloadFirstSearchResult: false,
  })
  await waitForHealth(baseUrl)
})

afterAll(async () => {
  await client.close()
  harness.kill("SIGTERM")
  await once(harness, "exit")
  upstream.close()
  await once(upstream, "close")
})

it("30 warmups and 200 samples satisfy deterministic Node-to-Rust gates", async () => {
  // Given: one release Rust process, a deterministic upstream, and a real Node cache.
  for (let index = 0; index < 30; index += 1) await timedSearch(`warmup-${index}`)
  const queries = Array.from({ length: 200 }, (_, index) => `sample-${index}`)

  // When: 100 serial and 100 concurrency-four misses are followed by identical cache hits.
  const uncached: number[] = []
  for (const query of queries.slice(0, 100)) uncached.push(await timedSearch(query))
  for (let index = 100; index < queries.length; index += 4) {
    uncached.push(...(await Promise.all(queries.slice(index, index + 4).map(timedSearch))))
  }
  const callsAfterMisses = upstreamCalls
  const cached: number[] = []
  for (const query of queries.slice(0, 100)) cached.push(await timedSearch(query))
  for (let index = 100; index < queries.length; index += 4) {
    cached.push(...(await Promise.all(queries.slice(index, index + 4).map(timedSearch))))
  }

  // Then: absolute latency, parity, error, call-count, and private Rust counter gates hold.
  expect(uncached).toHaveLength(200)
  expect(cached).toHaveLength(200)
  expect(p95(uncached)).toBeLessThan(1_000)
  expect(p95(cached)).toBeLessThan(10)
  expect(upstreamCalls).toBe(230)
  expect(upstreamCalls).toBe(callsAfterMisses)
  const upstreamStarted = rustEvents.filter(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      "stage" in event &&
      event.stage === "innertube_upstream" &&
      "outcome" in event &&
      event.outcome === "started",
  )
  const upstreamSucceeded = rustEvents.filter(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      "stage" in event &&
      event.stage === "innertube_upstream" &&
      "outcome" in event &&
      event.outcome === "success",
  )
  expect(upstreamStarted).toHaveLength(230)
  expect(upstreamSucceeded).toHaveLength(230)
  process.stdout.write(
    `${JSON.stringify({
      scenario: "deterministic-node-to-release-rust",
      warmups: 30,
      uncachedSamples: uncached.length,
      cachedSamples: cached.length,
      concurrency: [1, 4],
      upstreamCalls,
      errors: 0,
      parityPercent: 100,
      uncachedP95Ms: p95(uncached),
      cachedP95Ms: p95(cached),
      rustProviderStarted: upstreamStarted.length,
      rustProviderSucceeded: upstreamSucceeded.length,
    })}\n`,
  )
})
