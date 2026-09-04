import { type ChildProcess, spawn } from "node:child_process"
import { once } from "node:events"
import { createServer, request as httpRequest } from "node:http"
import { createServer as createNetServer } from "node:net"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

import { GuildIdSchema, type SearchResult, UserIdSchema } from "@discord-music/contracts"
import Fastify, { type FastifyInstance } from "fastify"

import { registerStateRoutes } from "../../src/api/state-routes.js"
import type { SearchApi } from "../../src/api/types.js"
import { YouTubeMusicSource } from "../../src/media/youtube.js"
import { createYouTubeExtractorRollout } from "../../src/media/youtube-extractor-rollout.js"
import { YouTubeSidecarClient } from "../../src/media/youtube-sidecar-client.js"
import type {
  SidecarRuntimeObservation,
  SidecarRuntimeObservationSink,
} from "../../src/media/youtube-sidecar-observation.js"

export type Deferred<Value> = {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
}

export type HttpSearchResult =
  | { readonly kind: "response"; readonly statusCode: number; readonly body: unknown }
  | { readonly kind: "closed" }

export type PendingHttpSearch = {
  readonly completion: Promise<HttpSearchResult>
  readonly destroy: () => void
}

export function deferred<Value>(): Deferred<Value> {
  let resolve: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve
  })
  if (resolve === undefined) throw new TypeError("Deferred was not initialized")
  return { promise, resolve }
}

export async function startSearchApp(
  search: SearchApi,
  observe: SidecarRuntimeObservationSink,
): Promise<{ readonly app: FastifyInstance; readonly address: string }> {
  const app = Fastify({ logger: false })
  registerStateRoutes(app, {
    sessions: {
      issue: () => ({ value: "valid", expiresAt: new Date(28_801_000) }),
      authorize: (value) =>
        value === "valid"
          ? { userId: UserIdSchema.parse("user-a"), expiresAt: new Date(28_801_000) }
          : null,
      revoke: () => undefined,
    },
    snapshots: {
      snapshot: () => {
        throw new TypeError("Snapshot route is outside this fixture")
      },
    },
    search,
    guildId: GuildIdSchema.parse("guild"),
    history: { list: () => [] },
    voiceChannels: async () => [],
    observeMediaSidecar: observe,
  })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  return { app, address }
}

export function beginHttpSearch(address: string, query: string): PendingHttpSearch {
  const payload = JSON.stringify({ q: query })
  const request = httpRequest(new URL("/api/search", address), {
    method: "POST",
    headers: {
      authorization: "Bearer valid",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
  })
  const completion = new Promise<HttpSearchResult>((resolve) => {
    request.once("response", (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        resolve({
          kind: "response",
          statusCode: response.statusCode ?? 0,
          body: JSON.parse(text),
        })
      })
    })
    request.once("error", () => resolve({ kind: "closed" }))
  })
  request.end(payload)
  return {
    completion,
    destroy: () => request.destroy(),
  }
}

export function searchApi(
  search: (query: string, signal?: AbortSignal) => Promise<readonly SearchResult[]>,
): SearchApi {
  return {
    search,
    playlist: async () => {
      throw new TypeError("Playlist route is outside this fixture")
    },
  }
}

function recordRustEvents(events: unknown[], drained: Deferred<void>): (chunk: Buffer) => void {
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
          const event: unknown = JSON.parse(outer.fields.observation)
          events.push(event)
          if (
            typeof event === "object" &&
            event !== null &&
            "stage" in event &&
            event.stage === "registry" &&
            "counterDelta" in event &&
            event.counterDelta === -1
          )
            drained.resolve()
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
  }
}

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

export async function startRustSearchApp(events: SidecarRuntimeObservation[]): Promise<{
  readonly app: FastifyInstance
  readonly address: string
  readonly drained: Promise<void>
  readonly localCalls: () => number
  readonly rustEvents: () => readonly unknown[]
  readonly close: () => Promise<void>
}> {
  const upstream = createServer((request) => request.resume())
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const upstreamAddress = upstream.address()
  if (upstreamAddress === null || typeof upstreamAddress === "string")
    throw new TypeError("Expected upstream address")
  const port = await freePort()
  const repositoryRoot = join(import.meta.dirname, "../../../..")
  const harness: ChildProcess = spawn(
    join(repositoryRoot, "apps/media-sidecar/target/release/media-sidecar-test-harness"),
    [],
    {
      env: {
        ...process.env,
        SIDECAR_HOST: "127.0.0.1",
        SIDECAR_PORT: String(port),
        SIDECAR_TEST_UPSTREAM: `http://127.0.0.1:${upstreamAddress.port}/youtubei/v1/search`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const drained = deferred<void>()
  const rustEvents: unknown[] = []
  harness.stdout?.on("data", recordRustEvents(rustEvents, drained))
  harness.stderr?.on("data", recordRustEvents(rustEvents, drained))
  const client = new YouTubeSidecarClient({ baseUrl: `http://127.0.0.1:${port}` })
  let ready = false
  const readinessDeadline = performance.now() + 3_000
  while (performance.now() < readinessDeadline) {
    try {
      await client.health()
      ready = true
      break
    } catch (error) {
      if (!(error instanceof Error)) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  }
  if (!ready) throw new TypeError("Rust harness did not become ready")
  let localCalls = 0
  const rollout = createYouTubeExtractorRollout({
    mode: "rust",
    local: {
      resolve: async () => {
        localCalls += 1
        throw new TypeError("Caller abort must not fallback")
      },
    },
    localSearch: {
      search: async () => {
        localCalls += 1
        throw new TypeError("Caller abort must not fallback")
      },
    },
    createSidecar: () => ({
      search: (query, signal) => client.search(query, signal),
      resolve: (track, signal) => client.resolve(track, signal),
      close: () => client.close(),
    }),
  })
  const source = new YouTubeMusicSource(undefined, undefined, {
    searchClient: rollout,
    observe: (event) => events.push(event),
  })
  const runtime = await startSearchApp(searchApi(source.search.bind(source)), (event) =>
    events.push(event),
  )
  return {
    ...runtime,
    drained: drained.promise,
    localCalls: () => localCalls,
    rustEvents: () => rustEvents,
    close: async () => {
      await runtime.app.close()
      await rollout.close()
      harness.kill("SIGTERM")
      await once(harness, "exit")
      upstream.closeAllConnections()
      upstream.close()
      await once(upstream, "close")
    },
  }
}
