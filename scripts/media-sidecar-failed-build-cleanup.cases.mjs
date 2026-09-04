import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url), "utf8")
const buildLog = (imageId, containerId) => ` ---> ${imageId}\n ---> Running in ${containerId}\n`

export function withFixture(callback) {
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
  const historicalSha = "3".repeat(40)
  const run = join(backup, runId)
  const historicalRun = join(backup, historicalRunId)
  const ownerPath = join(fixture, "owner.sh")

  mkdirSync(join(run, "operations"), { recursive: true })
  mkdirSync(join(historicalRun, "operations"), { recursive: true })
  for (const path of [repo, bin]) mkdirSync(path)
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
      '{{index .Config.Labels "org.opencontainers.image.revision"}}')
        test "${"$"}target" = 'discord-music-media-sidecar:${selectedSha}' && printf '%s\\n' "${"$"}SIDECAR_REVISION" || printf '%s\\n' "${"$"}SERVER_REVISION"
        ;;
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
  const split = owner.indexOf(['case "', "$", '{1:-}" in'].join(""))
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
    manifestCase = "valid",
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
    if (manifestCase === "wrong-schema") manifest.schema = "wrong"
    if (manifestCase === "missing-schema") delete manifest.schema
    if (manifestCase === "wrong-run") manifest.runId = `8-${"d".repeat(32)}`
    if (manifestCase === "missing-run") delete manifest.runId
    if (manifestCase === "wrong-sha") manifest.selectedSha = "e".repeat(40)
    if (manifestCase === "missing-sha") delete manifest.selectedSha
    const acceptedOperations = [{ operation, sequence, status }]
    writeFileSync(
      join(run, "manifest.json"),
      manifestCase === "malformed" ? "{" : JSON.stringify(manifest),
    )
    writeFileSync(
      lease,
      JSON.stringify({
        schema: "discord-music-deploy-lease.v1",
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
        generation: 6,
        selectedSha: historicalSha,
        kind: "deployment",
        configPath: "/opt/discord-music/deploy/compose.yaml",
        workingDir: "/opt/discord-music/deploy",
        eventCursor: "2026-09-04T00:00:00Z",
        composeHash: "4".repeat(64),
        envHash: "5".repeat(64),
        ownerHash: "6".repeat(64),
        desiredFingerprint: "7".repeat(64),
        priorState: {
          configHash: "4".repeat(64),
          envHash: "5".repeat(64),
          git: "8".repeat(40),
          mode: "rust",
          serverImage: `sha256:${"1".repeat(64)}`,
          sidecarImage: `sha256:${"2".repeat(64)}`,
          serverRef: "discord-music-server:prior",
          sidecarRef: "discord-music-media-sidecar:prior",
          sidecarPresent: true,
          publicHealth: {
            status: "ok",
            discord: "ready",
            voice: "idle",
            uptimeType: "number",
          },
          volumes: [],
        },
        priorPublicHealth: { status: "ok", discord: "ready", voice: "idle", uptime: 9 },
        rollbackTags: {
          server: `discord-music-rollback:${historicalRunId}-server`,
          sidecar: `discord-music-rollback:${historicalRunId}-sidecar`,
        },
      }),
    )
    writeFileSync(
      join(historicalRun, "terminal.json"),
      JSON.stringify({
        schema: "discord-music-deploy-lease.v1",
        runId: historicalRunId,
        generation: 6,
        selectedSha: historicalSha,
        sequence,
        deadlineClock: "CLOCK_BOOTTIME",
        deadlineBoottime: 999999,
        eventCursor: "2026-09-04T00:00:00Z",
        state: "expired",
        restoreState: "restored",
        stableSamples: 2,
        lateDaemonDetected: false,
        reconcilePasses: 0,
        eventProof: {
          cursor: "2026-09-04T00:00:00Z",
          observedCount: 4,
          quietWindowEvents: 0,
          stableAtBoottime: 99,
        },
        acceptedOperations,
        activeMutation: null,
      }),
    )
    writeFileSync(
      join(historicalRun, "operations", `${sequence}.log`),
      buildLog("c".repeat(64), "d".repeat(64)),
    )
  }

  const invoke = ({
    callRunId = runId,
    callSha = selectedSha,
    inUseImage = "",
    project = "deploy",
    serverRevision = selectedSha,
    sidecarRevision = selectedSha,
  } = {}) =>
    spawnSync("bash", [ownerPath, "cleanup-failed-images", callRunId, callSha], {
      encoding: "utf8",
      env: {
        ...process.env,
        MEDIA_BACKUP_ROOT: backup,
        MEDIA_LEASE_FILE: lease,
        MEDIA_LOCK_FILE: lock,
        MEDIA_REPO: repo,
        DOCKER_IN_USE_IMAGE: inUseImage,
        MEDIA_COMPOSE_PROJECT: project,
        SERVER_REVISION: serverRevision,
        SIDECAR_REVISION: sidecarRevision,
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
      run,
      historicalRun,
      writeScenario,
    })
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}
