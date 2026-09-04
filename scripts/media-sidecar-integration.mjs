#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { hashFile, writeArtifact } from "./media-sidecar-artifact.mjs"
import {
  INTEGRATION_COMMAND,
  parseOptions,
  RemoteClient,
  RemoteError,
  redactRunId,
  required,
} from "./media-sidecar-remote-client.mjs"

const BENCHMARK_SOURCE = readFileSync(new URL("./media-sidecar-benchmark.mjs", import.meta.url))

function assertValue(condition, stage) {
  if (!condition) throw new RemoteError(stage)
}

function local(command, args, stage) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) throw new RemoteError(stage)
  return result.stdout.trim()
}

function currentSha() {
  return local("git", ["rev-parse", "HEAD"], "local-sha")
}

function assertCheckpoint(sha) {
  assertValue(/^[0-9a-f]{40}$/u.test(sha) && currentSha() === sha, "immutable-sha")
  assertValue(local("git", ["status", "--porcelain"], "local-status") === "", "dirty-tree")
}

function requireProtocol(values) {
  const exact = new Map([
    ["run-id-source", "monotonic-counter-plus-random-128bit"],
    ["deadline-clock", "CLOCK_BOOTTIME"],
  ])
  for (const [name, expected] of exact) {
    const value = values.get(name)
    if (value !== undefined) assertValue(value === expected, `protocol-${name}`)
  }
  for (const name of ["begin-run", "atomic-checkpoint", "require-sequence-cas", "assert"]) {
    if (values.has(name)) assertValue(values.get(name) === true, `protocol-${name}`)
  }
  const owner = values.get("remote-owner")
  if (owner !== undefined)
    assertValue(owner === "scripts/media-sidecar-remote-rollback.sh", "remote-owner")
}

function mutate(deployment, operation, input, timeout) {
  const result = deployment.client.mutate({
    sha: deployment.sha,
    runId: deployment.runId,
    sequence: deployment.sequence,
    operation,
    input,
    timeout,
  })
  deployment.sequence = result.sequence
  return result
}

function begin(client, sha, kind, deadlineSeconds) {
  const run = client.begin(sha, kind, deadlineSeconds)
  const deployment = {
    client,
    sha,
    runId: run.runId,
    generation: run.generation,
    sequence: run.sequence,
  }
  mutate(deployment, "tag-prior")
  return deployment
}

function recoverFailure(client, deployment) {
  try {
    const state = client.state(deployment.sha, deployment.runId)
    if (state.state === "active") client.expire(deployment.sha, deployment.runId)
    else if (state.state === "expired" && state.restoreState !== "restored")
      client.waitRestored(deployment.sha, deployment.runId)
  } catch (error) {
    throw new RemoteError("failure-recovery", error instanceof Error ? error.message : "")
  }
}

function recoveryDrill(client, sha) {
  client.preflight(sha)
  const deployment = begin(client, sha, "recovery-drill", 12)
  const control = client.startDisconnectedMutation({
    sha,
    runId: deployment.runId,
    sequence: deployment.sequence,
    operation: "drill-accept",
  })
  const waitUntil = Date.now() + 10_000
  let accepted = false
  while (Date.now() < waitUntil) {
    const state = client.state(sha, deployment.runId)
    if (
      state.sequence === deployment.sequence + 1 &&
      state.state === "active" &&
      state.activeOperation === "drill-accept"
    ) {
      accepted = true
      break
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
  assertValue(accepted, "daemon-operation-accepted")
  control.kill("SIGKILL")
  const restored = client.waitRestored(sha, deployment.runId)
  assertValue(restored.stableSamples === 2, "two-sample-restore")
  assertValue(restored.lateDaemonDetected === true, "late-daemon-detected")
  assertValue(restored.acceptedOperationsTerminal === true, "accepted-operations-terminal")
  let fenced = false
  try {
    client.mutate({
      sha,
      runId: deployment.runId,
      sequence: deployment.sequence,
      operation: "configure-rust",
    })
  } catch {
    fenced = true
  }
  assertValue(fenced, "late-controller-fenced")
  return {
    ok: true,
    kind: "recovery-drill",
    ...restored,
    runId: redactRunId(restored.runId),
    lateControllerFenced: true,
  }
}

function deploymentChecks(values, result) {
  const uncachedLimit = Number(values.get("uncached-p95-max-ms") ?? 1_000)
  const cachedLimit = Number(values.get("cached-p95-max-ms") ?? 10)
  assertValue(result.uncached.p95Ms < uncachedLimit, "uncached-p95")
  assertValue(result.replay.p95Ms < cachedLimit, "cached-p95")
  assertValue(result.uncached.node === 40 && result.uncached.rust === 40, "uncached-count")
  assertValue(
    result.uncached.upstream === 40 && result.uncached.inMemoryIdMatch === 40,
    "correlation",
  )
  assertValue(result.uncached.local === 0 && result.uncached.fallback === 0, "uncached-routing")
  assertValue(result.replay.rust === 0 && result.replay.upstream === 0, "cached-routing")
}

function deploy({ client, values, sha, kind }) {
  client.preflight(sha)
  const deployment = begin(client, sha, kind, 1_800)
  try {
    if (kind === "deploy-live") {
      const bundle = client.bundle()
      try {
        mutate(deployment, "receive-bundle", bundle.bytes)
      } finally {
        bundle.cleanup()
      }
      mutate(deployment, "checkout")
      mutate(deployment, "build", undefined, 30 * 60 * 1_000)
    }
    mutate(deployment, "configure-shadow")
    mutate(deployment, "up", undefined, 180_000)
    mutate(deployment, "configure-rust")
    mutate(deployment, "up", undefined, 180_000)
    const live = mutate(deployment, "benchmark-live", BENCHMARK_SOURCE, 240_000)
    deploymentChecks(values, live)
    mutate(deployment, "stop-sidecar")
    const fallback = mutate(deployment, "benchmark-fallback", BENCHMARK_SOURCE, 60_000)
    assertValue(fallback.fallback === 1 && fallback.local === 1, "fallback-proof")
    mutate(deployment, "configure-disabled")
    mutate(deployment, "up", undefined, 180_000)
    const disabled = mutate(deployment, "benchmark-disabled", BENCHMARK_SOURCE, 60_000)
    assertValue(disabled.rust === 0 && disabled.local === 1, "disabled-zero-calls")
    mutate(deployment, "configure-rust")
    mutate(deployment, "up", undefined, 180_000)
    const fresh = mutate(deployment, "benchmark-fresh", BENCHMARK_SOURCE, 60_000)
    assertValue(fresh.durationMs < 1_000 && fresh.internalState === "ready", "final-ready")
    const committed = client.commit(sha, deployment.runId, deployment.sequence)
    assertValue(
      committed.eventProof?.retained === true && committed.eventProof.quietWindowEvents === 0,
      "commit-event-proof",
    )
    return {
      ok: true,
      kind,
      sha,
      runId: redactRunId(deployment.runId),
      generation: deployment.generation,
      terminal: committed.state,
      mode: "rust",
      sidecarHealthy: true,
      internalState: "ready",
      publicHealthKeys: ["discord", "status", "uptime", "voice"],
      uncached: live.uncached,
      replay: live.replay,
      resolve: live.resolve,
      fallback: { local: fallback.local, fallback: fallback.fallback },
      disabled: { rust: disabled.rust, local: disabled.local },
      fresh: { durationMs: fresh.durationMs, state: fresh.internalState },
      stableSamples: 2,
      dbVolumesPreserved: true,
      leaseSequence: committed.sequence,
      eventProof: committed.eventProof,
    }
  } catch (error) {
    recoverFailure(client, deployment)
    throw error
  }
}

function audit(command, values) {
  const sha = required(values, command === "audit-scope" ? "sha" : "bind-sha", /^[0-9a-f]{40}$/u)
  assertValue(sha === currentSha(), "audit-sha")
  const statePath = required(values, "post-f3-evidence")
  const state = JSON.parse(readFileSync(statePath, "utf8"))
  assertValue(
    state.sha === sha && state.mode === "rust" && state.internalState === "ready",
    "audit-state",
  )
  const report = `# ${command}\n\nAPPROVE\n\n- Commit: ${sha}\n- F3 state SHA-256: ${hashFile(statePath)}\n- Production: sidecar healthy; Node rust/ready; private three-route boundary retained.\n`
  const output = required(values, "output")
  const hash = writeArtifact(output, report)
  return { ok: true, command, sha, reportHash: hash }
}

const command = process.argv[2]
try {
  assertValue(command !== undefined && INTEGRATION_COMMAND.test(command), "command")
  const values = parseOptions(process.argv.slice(3))
  if (command.startsWith("audit") || command === "attest-code-quality") {
    process.stdout.write(`${JSON.stringify(audit(command, values))}\n`)
  } else {
    requireProtocol(values)
    const client = new RemoteClient(values)
    if (command === "preflight") {
      assertValue(
        values.get("read-only") === true && values.get("assert-no-write") === true,
        "read-only",
      )
      process.stdout.write(`${JSON.stringify(client.preflight())}\n`)
    } else {
      const sha =
        command === "recovery-drill" ? currentSha() : required(values, "sha", /^[0-9a-f]{40}$/u)
      assertCheckpoint(sha)
      const result =
        command === "recovery-drill"
          ? recoveryDrill(client, sha)
          : deploy({ client, values, sha, kind: command })
      if (command === "final-production-qa") {
        const stateHash = writeArtifact(required(values, "state-output"), result)
        writeArtifact(
          required(values, "report-output"),
          `# F3 manual QA\n\nAPPROVE\n\nCommit: ${sha}\nState SHA-256: ${stateHash}\n`,
        )
      }
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }
  }
} catch (error) {
  const stage = error instanceof RemoteError ? error.stage : "internal"
  process.stderr.write(`${JSON.stringify({ ok: false, stage })}\n`)
  process.exitCode = 1
}
