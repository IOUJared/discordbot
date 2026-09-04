import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

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
  assert.match(owner, /docker builder prune --filter until=0s --force/u)
  assert.doesNotMatch(owner, /docker (?:system|image|volume) prune/u)
  assert.doesNotMatch(owner, /docker builder prune(?! --filter until=0s --force)/u)
  assert.match(owner, /qa_ref="discord-music-media-sidecar:qa-\$selected_sha"/u)
  assert.match(owner, /temporaryQaImageRemoved/u)
  assert.match(owner, /cache-cleanup-qa-project/u)
  assert.match(owner, /cache-cleanup-qa-revision/u)
})

test("terminal build-cache cleanup rejects active builds and preserves image and volume identity", () => {
  const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url), "utf8")
  const start = owner.indexOf("cleanup_terminal_build_cache() {")
  const definition = owner.slice(start, owner.indexOf("commit_run() {", start))
  const fixture = mkdtempSync(join(tmpdir(), "media-build-cache-cleanup-"))
  const lease = join(fixture, "lease.json")
  const lock = join(fixture, "deploy.lock")
  const marker = join(fixture, "pruned")
  const runId = `1-${"d".repeat(32)}`
  const sha = "e".repeat(40)
  writeFileSync(
    lease,
    JSON.stringify({
      runId,
      selectedSha: sha,
      state: "committed",
      restoreState: "idle",
      activeMutation: null,
      acceptedOperations: [],
    }),
  )
  const probe = `
MS_LOCK=${JSON.stringify(lock)}
MS_LEASE=${JSON.stringify(lease)}
MS_REPO=/opt/discord-music
require_root() { :; }
require_paths() { :; }
die() { printf '%s\\n' "$1" >&2; exit 1; }
lease_value() { jq -er "$1" "$MS_LEASE"; }
active_config() { printf 'compose'; }
state_fingerprint() { printf 'stable-state'; }
docker_image_identity() { printf 'same-images\\n'; }
docker_volume_identity() { printf 'same-volumes\\n'; }
ps() { test "\${FAKE_ACTIVE:-0}" = 1 && printf 'docker build /source\\n' || :; }
df() { printf 'Filesystem 1M-blocks Used Available Capacity Mounted\\n/dev/test 9000 4000 4096 50%% /\\n'; }
docker() {
  test "$*" = 'builder prune --filter until=0s --force'
  : >${JSON.stringify(marker)}
}
${definition}
cleanup_terminal_build_cache ${JSON.stringify(runId)} ${JSON.stringify(sha)}
`
  try {
    const activeBuild = spawnSync("bash", ["-s"], {
      input: probe,
      encoding: "utf8",
      env: { ...process.env, FAKE_ACTIVE: "1" },
    })
    assert.equal(activeBuild.status, 1)
    assert.match(activeBuild.stderr, /cache-cleanup-build-active/u)
    assert.throws(() => readFileSync(marker))

    const idle = spawnSync("bash", ["-s"], { input: probe, encoding: "utf8" })
    assert.equal(idle.status, 0, idle.stderr)
    assert.match(idle.stdout, /"filter":"until=0s"/u)
    assert.match(idle.stdout, /"temporaryQaImageRemoved":0/u)
    assert.match(idle.stdout, /"imagesUnchanged":true,"volumesUnchanged":true/u)
    assert.equal(readFileSync(marker, "utf8"), "")
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
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
