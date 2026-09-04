import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url), "utf8")
const day = 86_400_000
const digest = (value) => createHash("sha256").update(value).digest("hex")
const hex = (character, length) => character.repeat(length)

export function withRetentionFixture(callback) {
  const fixture = mkdtempSync(join(tmpdir(), "media-retention-owner-"))
  const backup = join(fixture, "backups")
  const repo = join(fixture, "repo")
  const bin = join(fixture, "bin")
  const lock = join(fixture, "owner.lock")
  const lease = join(backup, "active.json")
  const dockerState = join(fixture, "docker-state.tsv")
  const dockerMutations = join(fixture, "docker-mutations.log")
  const injectionMarker = join(fixture, "injected")
  const ownerPath = join(fixture, "owner.sh")
  for (const path of [backup, repo, bin]) mkdirSync(path, { recursive: true })
  for (const path of [lock, dockerState, dockerMutations]) writeFileSync(path, "unchanged\n")
  writeFileSync(lease, JSON.stringify({ runId: `99-${hex("9", 32)}` }))

  const dispatch = owner.indexOf(['case "', "$", '{1:-}" in'].join(""))
  const injected = `
require_root() { :; }
require_paths() { :; }
begin_run() {
  require_root
  require_paths
  exec 9>"$MS_LOCK"
  flock -x 9
  cleanup_retention_locked
}
`
  writeFileSync(ownerPath, `${owner.slice(0, dispatch)}${injected}${owner.slice(dispatch)}`)
  chmodSync(ownerPath, 0o700)
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -eu
state="$DOCKER_STATE"
mutations="$DOCKER_MUTATIONS"
if test "$1" = ps; then
  test -z "${"$"}{IN_USE_IMAGE:-}" || printf 'current-container\\n'
  exit 0
fi
if test "$1" = inspect; then
  test "$3" = '{{.Image}}' && test "$4" = current-container
  printf '%s\\n' "$IN_USE_IMAGE"
  exit 0
fi
if test "$1 $2" = 'image inspect'; then
  format="$4"; target="$5"
  row="$(awk -F '\\t' -v target="$target" '$1==target {print; exit}' "$state")"
  test -n "$row" || exit 1
  id="$(printf '%s' "$row" | cut -f2)"; revision="$(printf '%s' "$row" | cut -f3)"
  if test "${"$"}{TAG_MISMATCH:-0}" = 1 && case "$target" in *-server) true;; *) false;; esac; then id="sha256:${hex("f", 64)}"; fi
  test "${"$"}{WRONG_REVISION:-0}" != 1 || revision="${hex("e", 40)}"
  case "$format" in
    '{{.Id}}') printf '%s\\n' "$id" ;;
    '{{index .Config.Labels "org.opencontainers.image.revision"}}') printf '%s\\n' "$revision" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
case "$1 $2" in
  'image rm'|'image tag'|'container rm'|'volume rm') printf '%s\\n' "$*" >>"$mutations"; exit 0 ;;
esac
printf '%s\n' "$*" >>"$mutations"
exit 1
`,
  )
  chmodSync(join(bin, "docker"), 0o700)

  const addArchive = ({ generation, state = "committed", ageMs = 8 * day }) => {
    const runId = `${generation}-${hex(String(generation % 10), 32)}`
    const run = join(backup, runId)
    const compose = "services: {}\n"
    const env = "MEDIA_SIDECAR_MODE=rust\n"
    const selectedSha = hex(String((generation + 2) % 10), 40)
    const priorGit = hex(String((generation + 3) % 10), 40)
    const serverImage = `sha256:${hex(String((generation + 4) % 10), 64)}`
    const sidecarImage = `sha256:${hex(String((generation + 5) % 10), 64)}`
    const serverTag = `discord-music-rollback:${runId}-server`
    const sidecarTag = `discord-music-rollback:${runId}-sidecar`
    mkdirSync(run)
    writeFileSync(join(run, "compose.yaml"), compose)
    writeFileSync(join(run, "deploy.env"), env)
    const manifest = {
      schema: "discord-music-deploy-lease.v1",
      runId,
      generation,
      selectedSha,
      kind: "deployment",
      configPath: "/opt/discord-music/deploy/compose.yaml",
      workingDir: "/opt/discord-music/deploy",
      eventCursor: "2026-09-04T00:00:00Z",
      composeHash: digest(compose),
      envHash: digest(env),
      ownerHash: hex("a", 64),
      desiredFingerprint: hex("b", 64),
      priorState: {
        configHash: hex("c", 64),
        envHash: hex("d", 64),
        git: priorGit,
        mode: "rust",
        serverImage,
        sidecarImage,
        serverRef: `discord-music-server:${priorGit}`,
        sidecarRef: `discord-music-media-sidecar:${priorGit}`,
        sidecarPresent: true,
        publicHealth: { status: "ok", discord: "ready", voice: "idle", uptimeType: "number" },
        volumes: [{ name: "discord-data", destination: "/app/data" }],
      },
      priorPublicHealth: { status: "ok", discord: "ready", voice: "idle", uptime: 10 },
      rollbackTags: { server: serverTag, sidecar: sidecarTag },
    }
    const restored = state === "expired"
    const terminal = {
      schema: manifest.schema,
      runId,
      generation,
      selectedSha,
      sequence: 0,
      deadlineClock: "CLOCK_BOOTTIME",
      deadlineBoottime: 100,
      eventCursor: manifest.eventCursor,
      state,
      restoreState: restored ? "restored" : "idle",
      stableSamples: restored ? 2 : 0,
      lateDaemonDetected: false,
      reconcilePasses: 0,
      eventProof: restored
        ? {
            cursor: manifest.eventCursor,
            observedCount: 0,
            quietWindowEvents: 0,
            stableAtBoottime: 90,
          }
        : null,
      acceptedOperations: [],
      activeMutation: null,
    }
    writeFileSync(join(run, "manifest.json"), JSON.stringify(manifest))
    writeFileSync(join(run, "terminal.json"), JSON.stringify(terminal))
    writeFileSync(
      dockerState,
      `${readFileSync(dockerState, "utf8")}${serverTag}\t${serverImage}\t${priorGit}\n${serverImage}\t${serverImage}\t${priorGit}\n${sidecarTag}\t${sidecarImage}\t${priorGit}\n${sidecarImage}\t${sidecarImage}\t${priorGit}\n`,
    )
    const old = new Date(Date.now() - ageMs)
    utimesSync(run, old, old)
    return { manifest, terminal, run, runId, serverImage }
  }
  const invoke = (environment = {}) =>
    spawnSync("bash", [ownerPath, "begin-run"], {
      encoding: "utf8",
      env: {
        ...process.env,
        MEDIA_BACKUP_ROOT: backup,
        MEDIA_LEASE_FILE: lease,
        MEDIA_LOCK_FILE: lock,
        MEDIA_REPO: repo,
        DOCKER_STATE: dockerState,
        DOCKER_MUTATIONS: dockerMutations,
        PATH: `${bin}:${process.env.PATH}`,
        ...environment,
      },
    })
  try {
    callback({
      addArchive,
      dockerMutations,
      injectionMarker,
      invoke,
      lease,
      exists: existsSync,
      read: (path) => readFileSync(path, "utf8"),
      write: (path, value) => writeFileSync(path, value),
    })
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}
