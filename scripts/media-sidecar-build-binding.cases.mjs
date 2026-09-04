import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

test("build owner CAS rejects adversarial bindings before Docker and preserves exact build identity", () => {
  const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url), "utf8")
  const source = owner.slice(0, owner.indexOf(`case "\${1:-}" in`))
  const fixture = mkdtempSync(join(tmpdir(), "media-build-owner-cas-"))
  const backup = join(fixture, "backups")
  const lease = join(backup, "active.json")
  const lock = join(fixture, "deploy.lock")
  const dockerLog = join(fixture, "docker.log")
  const runId = `7-${"a".repeat(32)}`
  const sha = "b".repeat(40)

  const writeFixture = ({
    leaseRunId = runId,
    leaseSha = sha,
    leaseState = "active",
    manifestRunId = runId,
    manifestSha = sha,
    operation = "build-server",
    sequence = 1,
  } = {}) => {
    const run = join(backup, manifestRunId)
    mkdirSync(run, { recursive: true })
    writeFileSync(
      lease,
      JSON.stringify({
        runId: leaseRunId,
        selectedSha: leaseSha,
        state: leaseState,
        restoreState: "idle",
        sequence,
        activeMutation: { operation, sequence, pid: null, pgid: null },
        acceptedOperations: [{ operation, sequence, status: "accepted" }],
      }),
    )
    writeFileSync(
      join(run, "manifest.json"),
      JSON.stringify({
        schema: "discord-music-deploy-lease.v1",
        runId: manifestRunId,
        selectedSha: manifestSha,
        configPath: "/opt/discord-music/deploy/compose.yaml",
        workingDir: "/opt/discord-music/deploy",
      }),
    )
  }

  const run = (scenario, requestedOperation = "build-server") => {
    rmSync(backup, { recursive: true, force: true })
    writeFileSync(dockerLog, "")
    const callRunId = scenario === "wrong-run" ? `8-${"c".repeat(32)}` : runId
    writeFixture({
      leaseRunId: scenario === "wrong-run" ? runId : callRunId,
      manifestRunId: callRunId,
      leaseSha: scenario === "lease-revision" ? "c".repeat(40) : sha,
      manifestSha: scenario === "manifest-revision" ? "c".repeat(40) : sha,
      leaseState: scenario === "wrong-state" ? "committed" : "active",
      operation:
        scenario === "wrong-mode"
          ? "configure-rust"
          : scenario === "active-build"
            ? "build-sidecar"
            : requestedOperation,
    })
    const probe = `${source}
require_root() { :; }
require_paths() { :; }
git() { test "$*" = "-C /opt/discord-music rev-parse HEAD^{tree}" && printf 'tree\n'; }
docker() {
  printf '%s\n' "$*" >>${JSON.stringify(dockerLog)}
  case "$*" in
    'images -q --no-trunc') : ;;
    'build '*) test "\${DOCKER_BUILD_FAIL:-0}" = 1 && return 1 || : ;;
    *) return 1 ;;
  esac
}
perform ${JSON.stringify(callRunId)} 1 ${JSON.stringify(requestedOperation)}
`
    return spawnSync("bash", ["-s"], {
      input: probe,
      encoding: "utf8",
      env: {
        ...process.env,
        MEDIA_BACKUP_ROOT: backup,
        MEDIA_LEASE_FILE: lease,
        MEDIA_LOCK_FILE: lock,
        MEDIA_REPO: "/opt/discord-music",
        MEDIA_SELECTED_SHA:
          scenario === "sha-mismatch"
            ? "d".repeat(40)
            : scenario === "sha-injection"
              ? `${sha};touch ${join(fixture, "pwned")}`
              : sha,
        MEDIA_COMPOSE_PROJECT:
          scenario === "wrong-project"
            ? "other"
            : scenario === "project-injection"
              ? `deploy;touch ${join(fixture, "pwned")}`
              : "deploy",
        DOCKER_BUILD_FAIL: scenario === "build-failure" ? "1" : "0",
      },
    })
  }

  try {
    for (const scenario of [
      "sha-mismatch",
      "wrong-project",
      "wrong-run",
      "manifest-revision",
      "lease-revision",
      "wrong-mode",
      "active-build",
      "wrong-state",
      "sha-injection",
      "project-injection",
    ]) {
      const result = run(scenario)
      assert.equal(result.status, 1, `${scenario}: ${result.stdout}${result.stderr}`)
      assert.equal(readFileSync(dockerLog, "utf8"), "", scenario)
      assert.equal(existsSync(join(fixture, "pwned")), false, scenario)
    }

    for (const [scenario, operation, tag] of [
      ["valid-server", "build-server", "discord-music-server"],
      ["valid-sidecar", "build-sidecar", "discord-music-media-sidecar"],
      ["valid-combined", "build", "discord-music-server"],
    ]) {
      const valid = run(scenario, operation)
      assert.equal(valid.status, 0, valid.stderr)
      assert.match(
        readFileSync(dockerLog, "utf8"),
        new RegExp(`build -t ${tag}:${sha}[\\s\\S]+--build-arg BUILD_SHA=${sha} `, "u"),
      )
    }
    assert.match(
      readFileSync(dockerLog, "utf8"),
      new RegExp(
        `build -t discord-music-media-sidecar:${sha}[\\s\\S]+--build-arg BUILD_SHA=${sha} `,
        "u",
      ),
    )

    const failed = run("build-failure")
    assert.equal(failed.status, 1)
    const failedCalls = readFileSync(dockerLog, "utf8")
    assert.match(failedCalls, /build -t discord-music-server:/u)
    assert.doesNotMatch(failedCalls, /prune| image tag| compose/u)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
