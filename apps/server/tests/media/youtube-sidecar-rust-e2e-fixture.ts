import { type ChildProcess, spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

import type { FastifyInstance } from "fastify"
import { YouTubeMusicSource } from "../../src/media/youtube.js"
import { createYouTubeExtractorRollout } from "../../src/media/youtube-extractor-rollout.js"
import { YouTubeSidecarClient } from "../../src/media/youtube-sidecar-client.js"
import type {
  ExtractorRolloutObservation,
  SidecarClientObservation,
  SidecarRuntimeObservation,
} from "../../src/media/youtube-sidecar-observation.js"
import {
  type Deferred,
  deferred,
  searchApi,
  startSearchApp,
} from "./youtube-sidecar-e2e-fixture.js"

type NodeObservation =
  | ExtractorRolloutObservation
  | SidecarClientObservation
  | SidecarRuntimeObservation

export function rustCounterDeltas(events: readonly unknown[], expectedStage: string): number[] {
  return events.flatMap((event) =>
    typeof event === "object" &&
    event !== null &&
    "stage" in event &&
    event.stage === expectedStage &&
    "counterDelta" in event &&
    typeof event.counterDelta === "number"
      ? [event.counterDelta]
      : [],
  )
}

export function rustCorrelationIds(events: readonly unknown[]): string[] {
  return events.flatMap((event) =>
    typeof event === "object" &&
    event !== null &&
    "correlationId" in event &&
    typeof event.correlationId === "string"
      ? [event.correlationId]
      : [],
  )
}

export function rustStages(events: readonly unknown[]): string[] {
  return events.flatMap((event) =>
    typeof event === "object" &&
    event !== null &&
    "stage" in event &&
    typeof event.stage === "string"
      ? [event.stage]
      : [],
  )
}

function recordRustEvents(
  events: unknown[],
  started: Deferred<void>,
  drained: Deferred<void>,
): (chunk: Buffer) => void {
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
            event.counterDelta === 1
          )
            started.resolve()
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
  readonly started: Promise<void>
  readonly drained: Promise<void>
  readonly localCalls: () => number
  readonly nodeEvents: () => readonly NodeObservation[]
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
  const started = deferred<void>()
  const drained = deferred<void>()
  const rustEvents: unknown[] = []
  const nodeEvents: NodeObservation[] = []
  const recordNodeEvent = (event: NodeObservation): void => {
    nodeEvents.push(event)
  }
  harness.stdout?.on("data", recordRustEvents(rustEvents, started, drained))
  harness.stderr?.on("data", recordRustEvents(rustEvents, started, drained))
  const client = new YouTubeSidecarClient({
    baseUrl: `http://127.0.0.1:${port}`,
    observe: recordNodeEvent,
  })
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
  nodeEvents.splice(0)
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
    observe: recordNodeEvent,
    createSidecar: () => ({
      search: (query, signal) => client.search(query, signal),
      resolve: (track, signal) => client.resolve(track, signal),
      close: () => client.close(),
    }),
  })
  const source = new YouTubeMusicSource(undefined, undefined, {
    searchClient: rollout,
    observe: (event) => {
      events.push(event)
      recordNodeEvent(event)
    },
  })
  const runtime = await startSearchApp(searchApi(source.search.bind(source)), (event) => {
    events.push(event)
    recordNodeEvent(event)
  })
  return {
    ...runtime,
    started: started.promise,
    drained: drained.promise,
    localCalls: () => localCalls,
    nodeEvents: () => nodeEvents,
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
