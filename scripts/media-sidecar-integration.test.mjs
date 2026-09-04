import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import "./media-sidecar-attestation.cases.mjs"
import "./media-sidecar-build-binding.cases.mjs"
import "./media-sidecar-inspection.cases.mjs"
import "./media-sidecar-lease.cases.mjs"
import "./media-sidecar-remote-rollback.cases.mjs"
import "./media-sidecar-storage.cases.mjs"
import "./media-sidecar-storage-guards.cases.mjs"
import { redactRunId } from "./media-sidecar-remote-client.mjs"
import { validateObservation } from "./media-sidecar-run-model.mjs"

test("observation schema is private and rejects identifiers and secrets", () => {
  assert.equal(
    validateObservation({
      schema: "media_sidecar_observation.v1",
      stage: "client_success",
      operation: "search",
      correlationId: "00000000-0000-4000-8000-000000000001",
      fingerprint: "f".repeat(64),
    }),
    true,
  )
  for (const event of [
    { schema: "media_sidecar_observation.v1", stage: "x", query: "secret" },
    { schema: "media_sidecar_observation.v1", stage: "x", url: "https://youtube.com" },
    { schema: "wrong", stage: "x" },
  ])
    assert.throws(() => validateObservation(event))
})

test("repository lint excludes generated Rust output and the hash-locked raw corpus", () => {
  const config = JSON.parse(readFileSync(new URL("../biome.json", import.meta.url), "utf8"))
  assert.ok(config.files.includes.includes("!apps/media-sidecar/target"))
  assert.ok(config.files.includes.includes("!spec/media-sidecar/v1"))
})

test("server image makes the Corepack node-gyp launcher executable", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8")
  assert.match(dockerfile, /pnpm --version[\s\S]+node-gyp\/gyp\/gyp_main\.py[\s\S]+chmod 0755/u)
})

test("sidecar builder does not retain release intermediates in its image layer", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile.media-sidecar", import.meta.url), "utf8")
  assert.match(dockerfile, /install[^\n]+target\/release\/discord-music-media-sidecar \/out\//u)
  assert.match(dockerfile, /rm -rf target/u)
  assert.match(dockerfile, /COPY --from=build \/out\/discord-music-media-sidecar/u)
})

test("live resolve uses the first non-empty acceptance result", () => {
  const benchmark = readFileSync(new URL("./media-sidecar-benchmark.mjs", import.meta.url), "utf8")
  assert.match(benchmark, /first\.flatMap\(\(\{ results \}\) => results\)\.at\(0\)/u)
  assert.match(benchmark, /resolveSuccess = false[\s\S]+try[\s\S]+catch/u)
  assert.match(benchmark, /nonEmptyResults: first\.filter/u)
  assert.match(benchmark, /clientFailures: clientFailureCounts\(acceptEvents\)/u)
})

test("live acceptance stays within search plus preload extractor capacity", () => {
  const benchmark = readFileSync(new URL("./media-sidecar-benchmark.mjs", import.meta.url), "utf8")
  assert.match(benchmark, /for \(const query of queries\)[\s\S]+await timed\(query\)/u)
  assert.doesNotMatch(benchmark, /Promise\.all\(queries\.slice/u)
})

test("public integration output never exposes a random run-id suffix", () => {
  assert.equal(redactRunId(`12-${"a".repeat(32)}`), "12-<redacted>")
})
