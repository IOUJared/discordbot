import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  active,
  model,
  priorAbsent,
  priorPresent,
} from "./media-sidecar-integration-test-support.mjs"
import { fingerprint, ModelError } from "./media-sidecar-run-model.mjs"

test("benchmark results carry the next lease sequence", () => {
  const instance = model()
  const run = active(instance)
  const benchmark = instance.mutate({
    runId: run.runId,
    sequence: run.sequence,
    operation: "benchmark-live",
  })
  const next = instance.mutate({
    runId: run.runId,
    sequence: benchmark.sequence,
    operation: "stop-sidecar",
  })
  assert.equal(benchmark.sequence, run.sequence + 1)
  assert.equal(next.sequence, benchmark.sequence + 1)
  assert.equal(instance.lease.sequence, next.sequence)
  assert.throws(
    () =>
      instance.mutate({
        runId: run.runId,
        sequence: run.sequence,
        operation: "stale-after-benchmark",
      }),
    (error) => error instanceof ModelError && error.code === "stale_sequence",
  )
})

test("preflight is read-only and redacts protected bytes", () => {
  const instance = model()
  const before = structuredClone(instance.live)
  const result = instance.preflight()
  assert.deepEqual(instance.live, before)
  assert.deepEqual(instance.writes, [])
  assert.equal(result.fingerprint, fingerprint(before))
  assert.doesNotMatch(JSON.stringify(result), /SECRET|protected/u)
})

test("tracked deployment config replaces only checkpointed legacy config", () => {
  const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url), "utf8")
  const compose = readFileSync(new URL("../deploy/compose.yaml", import.meta.url), "utf8")
  assert.match(compose, /discord-music-server:\$\{DEPLOY_SHA:\?[^}]+\}/u)
  assert.match(compose, /discord-music-media-sidecar:\$\{DEPLOY_SHA:\?[^}]+\}/u)
  assert.match(owner, /managedLegacyConfig/u)
  assert.match(owner, /legacy-active-compose\.yaml/u)
  assert.match(owner, /git -C "\$MS_REPO" status --porcelain/u)
  assert.match(
    owner,
    /git -C "\$MS_REPO" reset --hard[^\n]+\n {4}cp "\$run\/compose\.yaml" "\$config"/u,
  )
  assert.doesNotMatch(compose, /discord-music-(?:server|media-sidecar):[0-9a-f]{40}/u)
})

test("begin-run is monotonic, random, archived, and unique by phase", () => {
  const instance = model()
  const drill = active(instance, "recovery-drill")
  instance.expire({ runId: drill.runId })
  const deploy = active(instance, "deploy-live")
  instance.commit({ runId: deploy.runId, sequence: deploy.sequence })
  const finalQa = active(instance, "final-production-qa")
  assert.deepEqual([drill.generation, deploy.generation, finalQa.generation], [1, 2, 3])
  assert.equal(new Set([drill.runId, deploy.runId, finalQa.runId]).size, 3)
  assert.match(finalQa.runId, /^3-[0-9a-f]{32}$/u)
  assert.equal(instance.archives.size, 2)
})

test("begin-run crash points never publish a partial active checkpoint", () => {
  for (const crashAt of ["after_counter_fsync", "after_temp_verify", "after_checkpoint_rename"]) {
    const instance = model()
    assert.throws(
      () => instance.beginRun({ sha: "b".repeat(40), kind: "drill", crashAt }),
      (error) => error instanceof ModelError && error.code === "injected_crash",
    )
    assert.equal(instance.lease, undefined)
    assert.equal(instance.counter, 1)
  }
})

test("one active lease and prior restoration are mandatory", () => {
  const instance = model()
  const run = active(instance)
  assert.throws(
    () => instance.beginRun({ sha: "c".repeat(40), kind: "other" }),
    (error) => error instanceof ModelError && error.code === "lease_busy",
  )
  instance.expire({ runId: run.runId })
  instance.lease.restoreState = "restoring"
  assert.throws(
    () => instance.beginRun({ sha: "c".repeat(40), kind: "other" }),
    (error) => error instanceof ModelError && error.code === "lease_busy",
  )
})

test("run-id and sequence CAS fence concurrent, stale, and late writers", () => {
  const instance = model()
  const run = active(instance)
  const writes = instance.writes.length
  for (const candidate of [
    { runId: `9-${"f".repeat(32)}`, sequence: run.sequence },
    { runId: run.runId, sequence: run.sequence - 1 },
  ]) {
    assert.throws(() => instance.mutate({ ...candidate, operation: "forbidden" }))
    assert.equal(instance.writes.length, writes)
  }
  instance.now = instance.lease.deadline
  assert.throws(
    () => instance.mutate({ runId: run.runId, sequence: run.sequence, operation: "late" }),
    (error) => error instanceof ModelError && error.code === "deadline",
  )
  assert.equal(instance.writes.length, writes)
})

test("deadline wins success race and terminal state cannot regress", () => {
  const instance = model()
  const run = active(instance)
  instance.now = instance.lease.deadline
  assert.throws(() => instance.commit({ runId: run.runId, sequence: run.sequence }))
  const restored = instance.expire({ runId: run.runId })
  assert.deepEqual(restored, {
    state: "expired",
    restoreState: "restored",
    stableSamples: 2,
    lateDaemonDetected: false,
  })
  const writes = instance.writes.length
  assert.throws(() => instance.commit({ runId: run.runId, sequence: run.sequence }))
  assert.throws(() => instance.expire({ runId: run.runId }))
  assert.equal(instance.writes.length, writes)
})

test("commit retains quiet daemon event proof and rejects unstable completion", () => {
  const unstable = model()
  const unstableRun = active(unstable)
  assert.throws(
    () =>
      unstable.commit({
        runId: unstableRun.runId,
        sequence: unstableRun.sequence,
        quietWindowEvents: 1,
      }),
    (error) => error instanceof ModelError && error.code === "daemon_not_quiet",
  )
  assert.equal(unstable.lease.state, "active")
  assert.equal(unstable.lease.eventProof, null)

  const instance = model()
  const run = active(instance)
  const committed = instance.commit({ runId: run.runId, sequence: run.sequence })
  assert.equal(committed.state, "committed")
  assert.deepEqual(instance.lease.eventProof, {
    cursor: 1,
    observedCount: 1,
    quietWindowEvents: 0,
    stableAtBoottime: 1_000,
  })
})

test("accepted daemon completion after first restore is detected and reconverged", () => {
  const instance = model(priorAbsent)
  const run = active(instance, "recovery-drill")
  instance.mutate({
    runId: run.runId,
    sequence: run.sequence,
    operation: "daemon-accepted",
    apply: (live) => {
      live.sidecarPresent = true
      live.mode = "rust"
    },
  })
  const beforeContainerIdentity = "container-old"
  const result = instance.expire({
    runId: run.runId,
    delayedDaemon: (live) => {
      live.sidecarPresent = true
      live.mode = "rust"
      live.replacementContainer = "container-new"
    },
  })
  assert.equal(result.restoreState, "restored")
  assert.equal(result.lateDaemonDetected, true)
  assert.equal(fingerprint(instance.live), fingerprint(priorAbsent))
  assert.ok(instance.events.includes("late_daemon_detected"))
  assert.notEqual(beforeContainerIdentity, "container-new")
  assert.deepEqual(instance.live.volumes, priorAbsent.volumes)
})

test("exact bytes restore for sidecar-present and sidecar-absent checkpoints", () => {
  for (const state of [priorPresent, priorAbsent]) {
    const instance = model(state)
    const run = active(instance)
    instance.mutate({
      runId: run.runId,
      sequence: run.sequence,
      operation: "replace",
      apply: (live) => {
        live.config = "new"
        live.env = "new"
        live.sidecarPresent = !state.sidecarPresent
      },
    })
    instance.expire({ runId: run.runId })
    assert.deepEqual(instance.live, state)
  }
})

test("retention removes only old validated terminal archives", () => {
  const instance = model()
  const first = active(instance)
  instance.expire({ runId: first.runId })
  const second = active(instance)
  instance.commit({ runId: second.runId, sequence: second.sequence })
  active(instance)
  instance.archives.set("restoring", { generation: 0, state: "expired", restoreState: "restoring" })
  instance.cleanup({ retainAfterGeneration: 3 })
  assert.deepEqual([...instance.archives.keys()], ["restoring"])
})
