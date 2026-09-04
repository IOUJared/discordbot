import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"

const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url))
const source = owner.toString("utf8")

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
    "recover-restoring",
    "cleanup-failed-images",
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
    "condition: service_healthy",
    "links: [media-sidecar]",
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
