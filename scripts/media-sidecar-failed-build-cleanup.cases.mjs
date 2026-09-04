import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url), "utf8")
const dispatchMarker = ['case "', "$", '{1:-}" in'].join("")

const buildLog = (imageId, containerId) => ` ---> ${imageId}\n ---> Running in ${containerId}\n`

function withFixture(callback) {
  const fixture = mkdtempSync(join(tmpdir(), "media-failed-build-cleanup-"))
  const backup = join(fixture, "backups")
  const repo = join(fixture, "repo")
  const lock = join(fixture, "deploy.lock")
  const lease = join(backup, "active.json")
  const dockerLog = join(fixture, "docker.log")
  const removedImages = join(fixture, "removed-images")
  const removedContainers = join(fixture, "removed-containers")
  const bin = join(fixture, "bin")
  const runId = `7-${"a".repeat(32)}`
  const historicalRunId = `6-${"c".repeat(32)}`
  const selectedSha = "b".repeat(40)
  const run = join(backup, runId)
  const historicalRun = join(backup, historicalRunId)
  const ownerPath = join(fixture, "owner.sh")

  mkdirSync(join(run, "operations"), { recursive: true })
  mkdirSync(join(historicalRun, "operations"), { recursive: true })
  mkdirSync(repo)
  mkdirSync(bin)
  for (const path of [lock, dockerLog, removedImages, removedContainers]) writeFileSync(path, "")

  const injection = `
require_root() { :; }
require_paths() { :; }
df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nmock 9999 1 9998 1%% /\\n'; }
docker() {
  printf '%s\\n' "$*" >>${JSON.stringify(dockerLog)}
  if test "$1 $2" = 'image inspect'; then
    local format="${"$"}4" target="${"$"}5" normalized
    case "${"$"}target" in
      discord-music-server:${selectedSha}) normalized='sha256:${"e".repeat(64)}' ;;
      discord-music-media-sidecar:${selectedSha}) normalized='sha256:${"f".repeat(64)}' ;;
      [0-9a-f][0-9a-f]*) normalized="sha256:${"$"}target" ;;
      sha256:*) normalized="${"$"}target" ;;
      *) return 1 ;;
    esac
    grep -Fxq "${"$"}target" ${JSON.stringify(removedImages)} && return 1
    grep -Fxq "${"$"}normalized" ${JSON.stringify(removedImages)} && return 1
    case "${"$"}format" in
      '{{.Id}}') printf '%s\\n' "${"$"}normalized" ;;
      '{{json .RepoTags}}') printf 'null\\n' ;;
      *) return 1 ;;
    esac
    return 0
  fi
  if test "$1 $2" = 'image rm'; then printf '%s\\n' "${"$"}3" >>${JSON.stringify(removedImages)}; return 0; fi
  if test "$1" = ps; then test -z "${"$"}{DOCKER_IN_USE_IMAGE:-}" || printf 'container-current\\n'; return 0; fi
  if test "$1" = inspect; then
    local format="${"$"}3" target="${"$"}4"
    grep -Fxq "${"$"}target" ${JSON.stringify(removedContainers)} && return 1
    case "${"$"}format" in
      '{{.Id}}') printf '%s\\n' "${"$"}target" ;;
      '{{.State.Status}}') printf 'exited\\n' ;;
      '{{len .Mounts}}') printf '0\\n' ;;
      '{{json .Config.Labels}}') printf 'null\\n' ;;
      '{{.Created}}') printf '2026-09-04T01:00:00Z\\n' ;;
      *) return 1 ;;
    esac
    return 0
  fi
  if test "$1 $2" = 'container rm'; then printf '%s\\n' "${"$"}3" >>${JSON.stringify(removedContainers)}; return 0; fi
  if test "$1" = images; then return 0; fi
  return 1
}
`
  const split = owner.indexOf(dispatchMarker)
  writeFileSync(ownerPath, `${owner.slice(0, split)}${injection}${owner.slice(split)}`)
  chmodSync(ownerPath, 0o700)
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
if test "$1" = inspect && test "$3" = '{{.Image}}' && test "$4" = container-current; then
  printf '%s\\n' "$DOCKER_IN_USE_IMAGE"
  exit 0
fi
exit 1
`,
  )
  chmodSync(join(bin, "docker"), 0o700)

  const writeScenario = ({
    operation,
    status = "failed",
    sequence = 5,
    state = "expired",
    restoreState = "restored",
    logSequence = sequence,
  }) => {
    writeFileSync(dockerLog, "")
    writeFileSync(removedImages, "")
    writeFileSync(removedContainers, "")
    rmSync(join(run, "operations"), { recursive: true, force: true })
    mkdirSync(join(run, "operations"))
    const manifest = {
      schema: "discord-music-deploy-lease.v1",
      runId,
      selectedSha,
      eventCursor: "2026-09-04T00:00:00Z",
      priorState: {
        serverImage: `sha256:${"1".repeat(64)}`,
        sidecarImage: `sha256:${"2".repeat(64)}`,
      },
    }
    const acceptedOperations = [{ operation, sequence, status }]
    writeFileSync(join(run, "manifest.json"), JSON.stringify(manifest))
    writeFileSync(
      lease,
      JSON.stringify({
        runId,
        selectedSha,
        state,
        restoreState,
        acceptedOperations,
        cleanup: null,
      }),
    )
    if (logSequence !== null)
      writeFileSync(
        join(run, "operations", `${logSequence}.log`),
        buildLog("a".repeat(64), "b".repeat(64)),
      )
    writeFileSync(
      join(historicalRun, "manifest.json"),
      JSON.stringify({
        schema: "discord-music-deploy-lease.v1",
        runId: historicalRunId,
        eventCursor: "2026-09-04T00:00:00Z",
      }),
    )
    writeFileSync(
      join(historicalRun, "terminal.json"),
      JSON.stringify({
        runId: historicalRunId,
        state: "expired",
        restoreState: "restored",
        acceptedOperations,
      }),
    )
    writeFileSync(
      join(historicalRun, "operations", `${sequence}.log`),
      buildLog("c".repeat(64), "d".repeat(64)),
    )
  }

  const invoke = ({ callRunId = runId, callSha = selectedSha, inUseImage = "" } = {}) =>
    spawnSync("bash", [ownerPath, "cleanup-failed-images", callRunId, callSha], {
      encoding: "utf8",
      env: {
        ...process.env,
        MEDIA_BACKUP_ROOT: backup,
        MEDIA_LEASE_FILE: lease,
        MEDIA_LOCK_FILE: lock,
        MEDIA_REPO: repo,
        DOCKER_IN_USE_IMAGE: inUseImage,
        PATH: `${bin}:${process.env.PATH}`,
      },
    })

  try {
    callback({
      dockerLog,
      invoke,
      lease,
      removedContainers,
      removedImages,
      writeScenario,
    })
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

test("failed split builds are cleaned through the fenced owner entrypoint", () => {
  withFixture(({ invoke, removedContainers, removedImages, writeScenario }) => {
    for (const operation of ["build", "build-server", "build-sidecar"]) {
      writeScenario({ operation })
      const result = invoke()
      assert.equal(result.status, 0, `${operation}: ${result.stderr}`)
      const output = JSON.parse(result.stdout)
      assert.equal(output.ok, true)
      assert.equal(output.volumesRemoved, 0)
      const images = readFileSync(removedImages, "utf8")
      const containers = readFileSync(removedContainers, "utf8")
      assert.match(images, new RegExp(`discord-music-server:${"b".repeat(40)}`, "u"))
      assert.match(images, new RegExp(`sha256:${"a".repeat(64)}`, "u"))
      assert.match(images, new RegExp(`sha256:${"c".repeat(64)}`, "u"))
      assert.doesNotMatch(images, new RegExp(`sha256:${"1".repeat(64)}`, "u"))
      assert.doesNotMatch(images, new RegExp(`sha256:${"2".repeat(64)}`, "u"))
      assert.match(containers, new RegExp("b".repeat(64), "u"))
      assert.match(containers, new RegExp("d".repeat(64), "u"))
    }
  })
})

test("failed-build cleanup rejects invalid ownership records before Docker mutation", () => {
  withFixture(({ dockerLog, invoke, lease, writeScenario }) => {
    for (const scenario of [
      { operation: "configure-rust" },
      { operation: "build-server", sequence: "../5" },
      { operation: "build-sidecar", logSequence: null },
      { operation: "build-server", status: "succeeded" },
      { operation: "build-sidecar", state: "active", restoreState: "idle" },
    ]) {
      writeScenario(scenario)
      const beforeLease = readFileSync(lease, "utf8")
      const result = invoke()
      assert.equal(result.status, 1, JSON.stringify(scenario))
      assert.equal(readFileSync(dockerLog, "utf8"), "", JSON.stringify(scenario))
      assert.equal(readFileSync(lease, "utf8"), beforeLease, JSON.stringify(scenario))
    }
    writeScenario({ operation: "build-server" })
    assert.equal(invoke({ callRunId: `8-${"d".repeat(32)}` }).status, 1)
    assert.equal(readFileSync(dockerLog, "utf8"), "")
    writeScenario({ operation: "build-sidecar" })
    assert.equal(invoke({ callSha: "e".repeat(40) }).status, 1)
    assert.equal(readFileSync(dockerLog, "utf8"), "")
  })
})

test("failed-build cleanup refuses to remove a selected image used by any container", () => {
  withFixture(({ invoke, removedImages, writeScenario }) => {
    writeScenario({ operation: "build-server" })
    const result = invoke({ inUseImage: `sha256:${"e".repeat(64)}` })
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), '{"ok":false,"stage":"cleanup-image-in-use"}')
    assert.equal(readFileSync(removedImages, "utf8"), "")
  })
})
