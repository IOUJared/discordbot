import { performance } from "node:perf_hooks"

import { parseConfig } from "/app/apps/server/dist/config.js"
import { createProductionMedia } from "/app/apps/server/dist/runtime/production.js"

const kind = process.env.MEDIA_BENCH_KIND
const runToken = process.env.MEDIA_BENCH_RUN
if (typeof runToken !== "string" || !/^[1-9][0-9]*-[0-9a-f]{32}$/u.test(runToken))
  throw new Error("invalid run token")

const events = []
const config = parseConfig(process.env)
const media = createProductionMedia(config, (event) => events.push(event))

function percentile95(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
}

async function timed(query) {
  const started = performance.now()
  const results = await media.source.search(query)
  return { elapsed: performance.now() - started, results }
}

async function timedRollout(query) {
  const started = performance.now()
  const results = await media.rollout.search(query)
  return { elapsed: performance.now() - started, results }
}

async function batches(queries) {
  const output = []
  for (let index = 0; index < queries.length; index += 4) {
    output.push(...(await Promise.all(queries.slice(index, index + 4).map(timed))))
  }
  return output
}

function eventCount(predicate) {
  return events.filter(predicate).length
}

function client(stage, operation = "search") {
  return eventCount((event) => event.stage === stage && event.operation === operation)
}

function rollout(stage) {
  return eventCount((event) => event.stage === stage)
}

async function live() {
  const prefix = runToken.slice(0, 8)
  const warmups = Array.from({ length: 30 }, (_, index) => `music warmup ${prefix} ${index}`)
  const acceptance = Array.from(
    { length: 40 },
    (_, index) => `official music video acceptance ${prefix} ${index}`,
  )
  await batches(warmups)
  const acceptStart = events.length
  const first = await batches(acceptance)
  const acceptEvents = events.slice(acceptStart)
  const acceptCorrelations = acceptEvents
    .filter((event) => event.stage === "client_success" && event.operation === "search")
    .map((event) => event.correlationId)
  const firstFingerprints = acceptEvents
    .filter((event) => event.stage === "in_memory_id_match")
    .map((event) => event.fingerprint)
  const replayStart = events.length
  const replay = await batches(acceptance)
  const replayEvents = events.slice(replayStart)
  const track = first.flatMap(({ results }) => results).at(0)?.track
  if (track === undefined) throw new Error("live search returned no track")
  const resolveStarted = performance.now()
  let resolveSuccess = false
  try {
    await media.source.resolve(track)
    resolveSuccess = true
  } catch {
    resolveSuccess = false
  }
  const resolveMs = performance.now() - resolveStarted
  const firstIds = first.map(({ results }) => results.map(({ track: item }) => item.id))
  const replayIds = replay.map(({ results }) => results.map(({ track: item }) => item.id))
  const acceptClientSent = acceptEvents.filter(
    (event) => event.stage === "client_sent" && event.operation === "search",
  ).length
  const acceptClientSuccess = acceptEvents.filter(
    (event) => event.stage === "client_success" && event.operation === "search",
  ).length
  const acceptMatches = acceptEvents.filter((event) => event.stage === "in_memory_id_match").length
  const acceptLocal = acceptEvents.filter((event) => event.stage === "local_extraction").length
  const acceptFallback = acceptEvents.filter((event) => event.stage === "fallback").length
  const replayRemote = replayEvents.filter(
    (event) => event.stage === "client_sent" && event.operation === "search",
  ).length
  const replayLocal = replayEvents.filter((event) => event.stage === "local_extraction").length
  const replayFallback = replayEvents.filter((event) => event.stage === "fallback").length
  const output = {
    private: { acceptCorrelations },
    result: {
      ok: true,
      operation: "benchmark-live",
      warmups: 30,
      uniqueAcceptance: 40,
      disjointKeys: new Set([...warmups, ...acceptance]).size === 70,
      uncached: {
        node: 40,
        clientSent: acceptClientSent,
        clientSuccess: acceptClientSuccess,
        inMemoryIdMatch: acceptMatches,
        local: acceptLocal,
        fallback: acceptFallback,
        p95Ms: percentile95(first.map(({ elapsed }) => elapsed)),
      },
      replay: {
        node: 40,
        rust: replayRemote,
        upstream: replayRemote,
        local: replayLocal,
        fallback: replayFallback,
        p95Ms: percentile95(replay.map(({ elapsed }) => elapsed)),
      },
      idsEqual: JSON.stringify(firstIds) === JSON.stringify(replayIds),
      fingerprintsValid:
        firstFingerprints.length === 40 &&
        firstFingerprints.every((fingerprint) => /^[0-9a-f]{64}$/u.test(fingerprint)),
      fingerprintCount: firstFingerprints.length,
      resolve: { observed: true, success: resolveSuccess, durationMs: resolveMs },
      internalState: media.rollout.state(),
      errors: 0,
    },
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

async function one(expectedKind) {
  const before = events.length
  const result = await timedRollout(`music ${expectedKind} ${runToken.slice(0, 8)}`)
  const relevant = events.slice(before)
  const output = {
    private: {},
    result: {
      ok: true,
      operation: `benchmark-${expectedKind}`,
      node: 1,
      rust: relevant.filter((event) => event.stage === "client_sent").length,
      local: relevant.filter((event) => event.stage === "local_extraction").length,
      fallback: relevant.filter((event) => event.stage === "fallback").length,
      resultCount: result.results.length,
      durationMs: result.elapsed,
      internalState: media.rollout.state(),
      clientSuccess: client("client_success"),
      sidecarOutcomes: rollout("sidecar_outcome"),
    },
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

try {
  if (kind === "live") await live()
  else if (kind === "fallback") await one("fallback")
  else if (kind === "disabled") await one("disabled")
  else if (kind === "fresh") await one("fresh")
  else throw new Error("invalid benchmark kind")
} finally {
  await media.rollout.close()
}
