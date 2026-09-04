import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url))
const source = owner.toString("utf8")
const compose = readFileSync(new URL("../deploy/compose.yaml", import.meta.url), "utf8")

test("remote owner contains irreversible lease and daemon gates", () => {
  for (const required of [
    "CLOCK_BOOTTIME",
    "flock",
    "active",
    "committed",
    "expired",
    "fencing",
    "restoring",
    "restored",
    "docker events",
    "--force-recreate",
    "--remove-orphans",
    "stableSamples",
    "lateDaemonDetected",
    "cleanup_retention_locked",
    "cleanup_stale_lease_temps_locked",
    "recover-restoring",
    "cleanup-failed-images",
    "build-sidecar",
    "build-server",
    "images-before-build",
    "remove_new_untagged_images",
    "task_build_image_ids",
    "task_build_container_ids",
    "task_event_floor",
    "supersededSelectedTagsRemoved",
    "temporaryQaTagsRemoved",
    "healthStatus",
    "searchStatus",
    "dnsCount",
    "mismatchFirst",
    "mismatchSecond",
    "restore-first-sample",
    "json_fingerprint",
    'sync -f "$payload"',
    '<"$payload"',
    "run-counter",
    "active.json",
    "setsid",
    "TERM",
    "KILL",
  ])
    assert.ok(source.includes(required), `missing ${required}`)
  assert.match(compose, /MEDIA_SIDECAR_URL: http:\/\/media-sidecar:3101/u)
  assert.match(compose, /media-sidecar:[\s\S]+expose: \["3101"\]/u)
  assert.doesNotMatch(compose, /condition: service_healthy/u)
  assert.doesNotMatch(compose, /links: \[media-sidecar\]/u)
  assert.doesNotMatch(source, /docker (system prune|volume rm)|down[^\n]*--volumes/u)
})

test("remote owner dispatches safely when streamed over standard input", () => {
  const result = spawnSync("bash", ["-s", "--", "invalid-command"], {
    input: owner,
    encoding: "utf8",
  })
  assert.equal(result.status, 1)
  assert.equal(result.stderr.trim(), '{"ok":false,"stage":"command"}')
})

test("remote owner initializes run paths without unbound local expansion", () => {
  const result = spawnSync("bash", ["-s", "--", "perform", "1-deadbeef", "1", "tag-prior"], {
    input: owner,
    encoding: "utf8",
    env: { ...process.env, MEDIA_BACKUP_ROOT: "/tmp/missing-media-sidecar-checkpoint" },
  })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stderr, /unbound variable/u)
})

test("remote owner hashes exact compact state bytes", () => {
  const prefix = source.slice(0, source.indexOf("preflight() {"))
  const probe = `${prefix}\nvalue='{"state":"ready"}'\nexpected=$(printf '%s' "$value" | sha256sum | cut -d' ' -f1)\ntest "$(json_fingerprint "$value")" = "$expected"\n`
  const result = spawnSync("bash", ["-s"], { input: probe, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
})

test("daemon quiet windows ignore periodic healthcheck exec noise", () => {
  const prefix = source.slice(0, source.indexOf("preflight() {"))
  const probe = `${prefix}
docker() {
  printf '%s\\n' '{"Action":"exec_create: probe"}' '{"Action":"exec_start: probe"}' '{"Action":"exec_die"}' '{"Action":"create"}'
}
test "$(project_mutation_event_count 1 2)" = 1
`
  const result = spawnSync("bash", ["-s"], { input: probe, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
})

test("lease temp cleanup is fenced by terminal state and strict file validation", () => {
  // Given: stale and fresh lease-shaped files coexist with invalid files under an active lease.
  const root = mkdtempSync(join(tmpdir(), "media-lease-temp-"))
  const lease = join(root, "active.json")
  const removable = `${lease}.tmp.99999991`
  const nonempty = `${lease}.tmp.99999992`
  const fresh = `${lease}.tmp.99999993`
  const invalid = `${lease}.tmp.not-a-pid`
  const wrongMode = `${lease}.tmp.99999994`
  const active = `${lease}.tmp.99999995`
  const livePid = `${lease}.tmp.${process.pid}`
  const old = new Date(Date.now() - 600_000)
  for (const path of [removable, fresh, invalid, wrongMode, active, livePid])
    writeFileSync(path, "")
  writeFileSync(nonempty, "retained")
  for (const path of [removable, nonempty, invalid, wrongMode, active, livePid])
    utimesSync(path, old, old)
  for (const path of [removable, nonempty, fresh, invalid, active, livePid]) chmodSync(path, 0o600)
  chmodSync(wrongMode, 0o644)
  writeFileSync(
    lease,
    JSON.stringify({ state: "active", restoreState: "idle", activeMutation: null }),
  )
  const prefix = source.slice(0, source.indexOf("preflight() {"))

  try {
    // When: cleanup runs under active, restoring, and finally terminal-idle lease states.
    let result = spawnSync("bash", ["-s"], {
      input: `${prefix}\ncleanup_stale_lease_temps_locked\n`,
      encoding: "utf8",
      env: { ...process.env, MEDIA_BACKUP_ROOT: root, MEDIA_LEASE_FILE: lease },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(active), true)
    writeFileSync(
      lease,
      JSON.stringify({
        state: "committed",
        restoreState: "idle",
        activeMutation: { operation: "up" },
      }),
    )
    result = spawnSync("bash", ["-s"], {
      input: `${prefix}\ncleanup_stale_lease_temps_locked\n`,
      encoding: "utf8",
      env: { ...process.env, MEDIA_BACKUP_ROOT: root, MEDIA_LEASE_FILE: lease },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(active), true)
    writeFileSync(
      lease,
      JSON.stringify({ state: "expired", restoreState: "restoring", activeMutation: null }),
    )
    result = spawnSync("bash", ["-s"], {
      input: `${prefix}\ncleanup_stale_lease_temps_locked\n`,
      encoding: "utf8",
      env: { ...process.env, MEDIA_BACKUP_ROOT: root, MEDIA_LEASE_FILE: lease },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(active), true)
    writeFileSync(
      lease,
      JSON.stringify({ state: "committed", restoreState: "idle", activeMutation: null }),
    )
    result = spawnSync("bash", ["-s"], {
      input: `${prefix}\ncleanup_stale_lease_temps_locked\n`,
      encoding: "utf8",
      env: { ...process.env, MEDIA_BACKUP_ROOT: root, MEDIA_LEASE_FILE: lease },
    })

    // Then: only dead-PID, zero-byte, mode-0600, stale lease temps are removed.
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(removable), false)
    assert.equal(existsSync(active), false)
    for (const retained of [nonempty, fresh, invalid, wrongMode, livePid])
      assert.equal(existsSync(retained), true, retained)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
