import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

test("terminal build-cache cleanup resolves QA image use and validates identity before mutation", () => {
  const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url), "utf8")
  const start = owner.indexOf("qa_image_in_use() {")
  const definition = owner.slice(start, owner.indexOf("commit_run() {", start))
  const fixture = mkdtempSync(join(tmpdir(), "media-build-cache-qa-guards-"))
  const lease = join(fixture, "lease.json")
  const lock = join(fixture, "deploy.lock")
  const marker = join(fixture, "qa-removed")
  const runId = `1-${"a".repeat(32)}`
  const sha = "b".repeat(40)
  const qaRef = `discord-music-media-sidecar:qa-${sha}`
  const qaProject = `discord-music-sidecar-qa-${sha.slice(0, 12)}`
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
  const probe = () => `
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
ps() { :; }
df() { printf 'Filesystem 1M-blocks Used Available Capacity Mounted\\n/dev/test 9000 4000 4096 50%% /\\n'; }
docker() {
  if test "\${1:-}" = image && test "\${2:-}" = inspect; then
    case "\${4:-}" in
      '{{.Id}}') test "\${5:-}" = '${qaRef}' && printf 'sha256:qa-image\\n' ;;
      *com.docker.compose.project*) test "\${5:-}" = '${qaRef}' && printf '%s\\n' "\${QA_PROJECT}" ;;
      *org.opencontainers.image.revision*) test "\${5:-}" = '${qaRef}' && printf '%s\\n' "\${QA_REVISION}" ;;
      *) exit 1 ;;
    esac
    return
  fi
  case "$*" in
    'ps -aq') test "\${QA_IN_USE:-0}" = 1 && printf 'container-1\\n' || : ;;
    'inspect -f {{.Image}} container-1') printf '%s\\n' "\${QA_CONTAINER_IMAGE:-sha256:other-image}" ;;
    'image rm ${qaRef}') : >${JSON.stringify(marker)} ;;
    'builder prune --filter until=0s --force') : ;;
    *) exit 1 ;;
  esac
}
${definition}
cleanup_terminal_build_cache ${JSON.stringify(runId)} ${JSON.stringify(sha)}
`
  const run = (scenario) =>
    spawnSync("bash", ["-s"], {
      input: probe(scenario),
      encoding: "utf8",
      env: {
        ...process.env,
        QA_PROJECT: scenario === "wrong-project" ? "wrong-project" : qaProject,
        QA_REVISION: scenario === "wrong-revision" ? "c".repeat(40) : sha,
        QA_IN_USE: scenario === "running" || scenario === "stopped" ? "1" : "0",
        QA_CONTAINER_IMAGE:
          scenario === "running" || scenario === "stopped"
            ? "sha256:qa-image"
            : "sha256:other-image",
      },
    })
  try {
    for (const scenario of ["running", "stopped", "wrong-project", "wrong-revision"]) {
      const result = run(scenario)
      assert.equal(result.status, 1, scenario)
      assert.match(
        result.stderr,
        new RegExp(
          scenario === "wrong-project"
            ? "cache-cleanup-qa-project"
            : scenario === "wrong-revision"
              ? "cache-cleanup-qa-revision"
              : "cache-cleanup-qa-in-use",
        ),
      )
      assert.equal(existsSync(marker), false, scenario)
    }
    const valid = run("valid")
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /"temporaryQaImageRemoved":1/u)
    assert.equal(readFileSync(marker, "utf8"), "")
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
