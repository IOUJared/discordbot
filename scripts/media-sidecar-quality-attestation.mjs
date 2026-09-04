import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { hashFile, writeArtifact } from "./media-sidecar-artifact.mjs"
import {
  PROOFS,
  REQUIRED_BOUNDARIES,
  SIZE_PATHS,
  SOURCE_PATHS,
} from "./media-sidecar-quality-boundaries.mjs"
import { RemoteError, required } from "./media-sidecar-remote-client.mjs"

const SHA = /^[0-9a-f]{40}$/u

function fail(stage) {
  throw new RemoteError(stage)
}

function requireBoundaries(values) {
  for (const boundary of REQUIRED_BOUNDARIES) {
    if (values.get(`require-${boundary}`) !== true) fail(`attestation-require-${boundary}`)
  }
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    fail("attestation-f3-state")
  }
}

function assertF3(state, sha) {
  const publicKeys = ["discord", "status", "uptime", "voice"]
  const valid =
    state.ok === true &&
    state.kind === "final-production-qa" &&
    state.sha === sha &&
    state.terminal === "committed" &&
    state.mode === "rust" &&
    state.sidecarHealthy === true &&
    state.internalState === "ready" &&
    JSON.stringify(state.publicHealthKeys) === JSON.stringify(publicKeys) &&
    state.uncached?.node === 40 &&
    state.uncached?.rust === 40 &&
    state.uncached?.upstream === 40 &&
    state.uncached?.inMemoryIdMatch === 40 &&
    state.uncached?.local === 0 &&
    state.uncached?.fallback === 0 &&
    state.uncached?.p95Ms < 1_000 &&
    state.replay?.node === 40 &&
    state.replay?.rust === 0 &&
    state.replay?.upstream === 0 &&
    state.replay?.local === 0 &&
    state.replay?.fallback === 0 &&
    state.replay?.p95Ms < 10 &&
    state.resolve?.observed === true &&
    state.resolve?.success === true &&
    state.fallback?.local === 1 &&
    state.fallback?.fallback === 1 &&
    state.disabled?.rust === 0 &&
    state.disabled?.local === 1 &&
    state.fresh?.durationMs < 1_000 &&
    state.fresh?.state === "ready" &&
    state.stableSamples === 2 &&
    state.dbVolumesPreserved === true &&
    Number.isSafeInteger(state.leaseSequence) &&
    state.eventProof?.retained === true &&
    state.eventProof?.quietWindowEvents === 0
  if (!valid) fail("attestation-f3-state")
}

function loadSources(root, sha) {
  const sources = new Map()
  try {
    for (const path of SOURCE_PATHS) {
      const source =
        typeof root === "string"
          ? readFileSync(resolve(root, path), "utf8")
          : execFileSync("git", ["show", `${sha}:${path}`], { encoding: "utf8" })
      sources.set(path, source)
    }
  } catch {
    fail("attestation-proof-source")
  }
  return sources
}

function pureLines(source) {
  let blockComment = false
  return source.split("\n").filter((line) => {
    const trimmed = line.trim()
    if (blockComment) {
      if (trimmed.includes("*/")) blockComment = false
      return false
    }
    if (trimmed.startsWith("/*")) {
      blockComment = !trimmed.includes("*/")
      return false
    }
    return trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("# ")
  }).length
}

function assertProofs(sources) {
  for (const [boundary, checks] of PROOFS) {
    for (const [path, pattern] of checks) {
      if (!pattern.test(sources.get(path) ?? "")) fail(`attestation-proof-${boundary}`)
    }
  }
  const compose = sources.get("deploy/compose.yaml") ?? ""
  const sidecar =
    compose.match(/\n {2}media-sidecar:\n([\s\S]+?)(?=\n {2}[a-z]|\nvolumes:)/u)?.[1] ?? ""
  if (sidecar === "" || /\n {4}ports:/u.test(sidecar)) fail("attestation-proof-private-observation")
  const cargo = sources.get("apps/media-sidecar/Cargo.toml") ?? ""
  const dependencies = cargo.match(/\[dependencies\]\n([\s\S]+?)\n\[lints/u)?.[1] ?? ""
  if (/version = "(?!=)/u.test(dependencies)) fail("attestation-proof-pins")
  for (const path of SIZE_PATHS) {
    if (pureLines(sources.get(path) ?? "") > 250) fail("attestation-proof-bounds")
  }
}

function attest(values, currentSha, sourceRoot) {
  const sha = required(values, "bind-sha", SHA)
  if (sha !== currentSha) fail("audit-sha")
  requireBoundaries(values)
  const statePath = required(values, "post-f3-evidence")
  assertF3(readState(statePath), sha)
  const sources = loadSources(sourceRoot, sha)
  assertProofs(sources)
  const sourceHash = createHash("sha256")
  for (const [path, source] of sources) sourceHash.update(path).update("\0").update(source)
  const report = `# attest-code-quality\n\nAPPROVE\n\n- Commit: ${sha}\n- F3 state SHA-256: ${hashFile(statePath)}\n- Source proof SHA-256: ${sourceHash.digest("hex")}\n- Enforced boundaries: ${REQUIRED_BOUNDARIES.join(", ")}\n`
  const output = required(values, "output")
  return {
    ok: true,
    command: "attest-code-quality",
    sha,
    reportHash: writeArtifact(output, report),
  }
}

export function attestCodeQuality(values, currentSha) {
  return attest(values, currentSha)
}

export function attestCodeQualityFixture(values, currentSha, sourceRoot) {
  return attest(values, currentSha, sourceRoot)
}
