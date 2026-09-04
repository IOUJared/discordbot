import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

test("mutate validates build bindings before advancing the real owner lease", () => {
  // Given: the actual owner CLI, a checkpointed lease, and Docker/git executables that record calls.
  const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url), "utf8")
  const fixture = mkdtempSync(join(tmpdir(), "media-build-owner-entrypoint-"))
  const backup = join(fixture, "backups")
  const repo = join(fixture, "repo")
  const runId = `7-${"a".repeat(32)}`
  const sha = "b".repeat(40)
  const run = join(backup, runId)
  const lease = join(backup, "active.json")
  const lock = join(fixture, "deploy.lock")
  const ownerPath = join(fixture, "owner.sh")
  const dockerLog = join(fixture, "docker.log")
  const bin = join(fixture, "bin")
  const marker = ['case "', "$", '{1:-}" in'].join("")
  mkdirSync(run, { recursive: true })
  mkdirSync(repo)
  mkdirSync(bin)
  writeFileSync(lock, "")
  writeFileSync(
    join(run, "manifest.json"),
    JSON.stringify({
      schema: "discord-music-deploy-lease.v1",
      runId,
      selectedSha: sha,
      configPath: join(repo, "compose.yaml"),
      workingDir: repo,
    }),
  )
  writeFileSync(join(repo, "compose.yaml"), "services: {}\n")
  const testOwner = `${owner.slice(0, owner.indexOf(marker))}
require_root() { :; }
require_paths() { :; }
${owner.slice(owner.indexOf(marker))}`
  writeFileSync(ownerPath, testOwner)
  chmodSync(ownerPath, 0o700)
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env bash
test "$*" = "-C ${repo} rev-parse HEAD^{tree}" && printf 'tree\n'
`,
  )
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
printf '%s\n' "$*" >>${JSON.stringify(dockerLog)}
case "$*" in
  'images -q --no-trunc') : ;;
  'build '*) : ;;
  *) exit 1 ;;
esac
`,
  )
  chmodSync(join(bin, "git"), 0o700)
  chmodSync(join(bin, "docker"), 0o700)

  const writeLease = ({
    leaseRunId = runId,
    leaseSha = sha,
    state = "active",
    activeMutation = null,
  } = {}) =>
    writeFileSync(
      lease,
      JSON.stringify({
        schema: "discord-music-deploy-lease.v1",
        runId: leaseRunId,
        selectedSha: leaseSha,
        sequence: 0,
        deadlineBoottime: 9999999999,
        state,
        restoreState: "idle",
        activeMutation,
        acceptedOperations: [],
      }),
    )

  const snapshot = () =>
    JSON.stringify({
      lease: readFileSync(lease, "utf8"),
      manifest: readFileSync(join(run, "manifest.json"), "utf8"),
      operations: existsSync(join(run, "operations")) ? readdirSync(join(run, "operations")) : [],
      lock: readFileSync(lock, "utf8"),
      docker: readFileSync(dockerLog, "utf8"),
    })
  const invoke = (scenario, operation = "build-server") => {
    rmSync(join(run, "operations"), { recursive: true, force: true })
    writeFileSync(dockerLog, "")
    const callRunId = scenario === "wrong-run" ? `8-${"c".repeat(32)}` : runId
    const manifestSha = scenario === "manifest-revision" ? "c".repeat(40) : sha
    writeFileSync(
      join(run, "manifest.json"),
      JSON.stringify({
        schema: "discord-music-deploy-lease.v1",
        runId,
        selectedSha: manifestSha,
        configPath: join(repo, "compose.yaml"),
        workingDir: repo,
      }),
    )
    writeLease({
      leaseRunId: scenario === "wrong-run" ? runId : callRunId,
      leaseSha: scenario === "lease-revision" ? "c".repeat(40) : sha,
      state: scenario === "wrong-state" ? "committed" : "active",
      activeMutation:
        scenario === "concurrent" ? { operation: "build-sidecar", sequence: 1 } : null,
    })
    const env = {
      ...process.env,
      MEDIA_REPO: repo,
      MEDIA_BACKUP_ROOT: backup,
      MEDIA_LOCK_FILE: lock,
      MEDIA_LEASE_FILE: lease,
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
      PATH: `${bin}:${process.env.PATH}`,
    }
    if (scenario === "project-omitted") delete env.MEDIA_COMPOSE_PROJECT
    const before = snapshot()
    const result = spawnSync("bash", [ownerPath, "mutate", callRunId, "0", operation], {
      input: "",
      encoding: "utf8",
      env,
    })
    return { result, before }
  }

  try {
    for (const scenario of [
      "sha-mismatch",
      "wrong-project",
      "project-omitted",
      "wrong-run",
      "manifest-revision",
      "lease-revision",
      "wrong-mode",
      "wrong-state",
      "concurrent",
      "sha-injection",
      "project-injection",
      "operation-injection",
    ]) {
      writeLease()
      const operation =
        scenario === "wrong-mode"
          ? "build-rust"
          : scenario === "operation-injection"
            ? `build-server;touch ${join(fixture, "pwned")}`
            : "build-server"
      const { result, before } = invoke(scenario, operation)
      assert.equal(result.status, 1, `${scenario}: ${result.stdout}${result.stderr}`)
      assert.equal(snapshot(), before, scenario)
      assert.equal(existsSync(join(fixture, "pwned")), false, scenario)
    }

    for (const [operation, tag] of [
      ["build-server", "discord-music-server"],
      ["build-sidecar", "discord-music-media-sidecar"],
      ["build", "discord-music-server"],
    ]) {
      writeLease()
      const { result: valid, before: validBefore } = invoke("valid", operation)
      assert.equal(valid.status, 0, valid.stderr)
      assert.notEqual(snapshot(), validBefore)
      const leaseAfter = JSON.parse(readFileSync(lease, "utf8"))
      assert.equal(leaseAfter.sequence, 1)
      assert.deepEqual(leaseAfter.acceptedOperations, [
        { sequence: 1, operation, status: "succeeded" },
      ])
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
    assert.deepEqual(readdirSync(join(run, "operations")), ["1.input", "1.log"])
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
