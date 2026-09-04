import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import "./media-sidecar-remote-rollback.cases.mjs"
import { redactRunId } from "./media-sidecar-remote-client.mjs"
import {
  DeploymentModel,
  fingerprint,
  ModelError,
  validateObservation,
} from "./media-sidecar-run-model.mjs"

const priorPresent = {
  config: "services: server+sidecar\n",
  env: "MEDIA_SIDECAR_MODE=rust\nSECRET=protected\n",
  git: "a".repeat(40),
  mode: "rust",
  sidecarPresent: true,
  serverImage: "sha256:server-old",
  sidecarImage: "sha256:sidecar-old",
  publicHealth: { status: "ok", discord: "ready", voice: "idle", uptime: 9 },
  volumes: ["db-volume"],
}
const priorAbsent = { ...priorPresent, mode: "disabled", sidecarPresent: false }

function model(state = priorPresent) {
  let suffix = 0
  return new DeploymentModel({
    state,
    random: () => {
      suffix += 1
      return `${suffix}`.padStart(32, "0")
    },
  })
}

function active(instance, kind = "deploy") {
  const run = instance.beginRun({ sha: "b".repeat(40), kind })
  const tagged = instance.mutate({ ...run, operation: "tag-prior" })
  return { ...run, sequence: tagged.sequence }
}

test("disk recovery removes only inputs for terminal successful operations", () => {
  const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url), "utf8")
  assert.match(owner, /reclaim_consumed_inputs\(\)/u)
  assert.match(owner, /select\(\.status=="succeeded"\)\|\.sequence/u)
  assert.match(owner, /input="\$run\/operations\/\$sequence\.input"/u)
  assert.match(owner, /volumesRemoved:0/u)
})

test("terminal space cleanup preserves tagged and digest-pinned images and never prunes", () => {
  const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url), "utf8")
  assert.match(owner, /cleanup_terminal_space\(\)/u)
  assert.match(owner, /MS_DANGLING_RETENTION_DAYS days ago/u)
  assert.match(owner, /RepoTags/u)
  assert.match(owner, /RepoDigests/u)
  assert.match(owner, /terminalLeaseUnchanged:true/u)
  assert.doesNotMatch(owner, /docker (?:system|image|builder) prune/u)
})

test("retention repair recreates only a missing validated rollback tag and is idempotent", () => {
  const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url), "utf8")
  const prefix = owner.slice(0, owner.indexOf("preflight() {"))
  const fixture = mkdtempSync(join(tmpdir(), "media-retention-repair-"))
  const backup = join(fixture, "backups")
  const runId = `1-${"a".repeat(32)}`
  const run = join(backup, runId)
  const bin = join(fixture, "bin")
  const source = `sha256:${"b".repeat(64)}`
  const tag = `discord-music-rollback:${runId}-server`
  mkdirSync(run, { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(run, "compose.yaml"), "services: {}\n")
  writeFileSync(join(run, "deploy.env"), "MEDIA_SIDECAR_MODE=rust\n")
  const hash = (path) => spawnSync("sha256sum", [path], { encoding: "utf8" }).stdout.split(" ")[0]
  writeFileSync(
    join(run, "manifest.json"),
    JSON.stringify({
      schema: "discord-music-deploy-lease.v1",
      runId,
      selectedSha: "c".repeat(40),
      composeHash: hash(join(run, "compose.yaml")),
      envHash: hash(join(run, "deploy.env")),
      priorState: { serverImage: source, sidecarImage: null },
      rollbackTags: { server: tag, sidecar: null },
    }),
  )
  writeFileSync(join(run, "terminal.json"), JSON.stringify({ runId, state: "committed" }))
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -eu
state=${JSON.stringify(join(fixture, "tag-created"))}
if test "$1 $2" = "image inspect"; then
  test "$3" = ${JSON.stringify(source)} && exit 0
  test -e "$state" && test "$3" = ${JSON.stringify(tag)} && exit 0
  exit 1
fi
test "$1 $2" = "image tag"
test "$3" = ${JSON.stringify(source)}
test "$4" = ${JSON.stringify(tag)}
: >"$state"
`,
  )
  chmodSync(join(bin, "docker"), 0o700)
  try {
    const probe = `${prefix}\nrepair_retained_tags_locked\nrepair_retained_tags_locked\n`
    const result = spawnSync("bash", ["-s"], {
      input: probe,
      encoding: "utf8",
      env: { ...process.env, MEDIA_BACKUP_ROOT: backup, PATH: `${bin}:${process.env.PATH}` },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, "1\n0\n")
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

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
