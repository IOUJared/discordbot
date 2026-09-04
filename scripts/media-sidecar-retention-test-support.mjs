import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installOwnerAdapters } from "./media-sidecar-owner-adapters.mjs"

const owner = readFileSync(new URL("./media-sidecar-remote-rollback.sh", import.meta.url), "utf8")
const day = 86_400_000
const digest = (value) => createHash("sha256").update(value).digest("hex")
const hex = (character, length) => character.repeat(length)

export function withRetentionFixture(callback) {
  const fixture = mkdtempSync(join(tmpdir(), "media-retention-owner-"))
  const backup = join(fixture, "root", "discord-music-rollbacks")
  const repo = join(fixture, "opt", "discord-music")
  const bin = join(fixture, "bin")
  const lock = join(fixture, "run", "lock", "discord-music-deploy.lock")
  const lease = join(backup, "active.json")
  const counter = join(backup, "run-counter")
  const deploy = join(repo, "deploy")
  const config = join(deploy, "compose.yaml")
  const envFile = join(deploy, ".env")
  const volumeMarker = join(fixture, "volume-state")
  const dockerState = join(fixture, "docker-state.tsv")
  const dockerMutations = join(fixture, "docker-mutations.log")
  const injectionMarker = join(fixture, "injected")
  const replacementMarker = join(fixture, "lease-replaced")
  const ownerPath = join(fixture, "owner.sh")
  for (const path of [backup, deploy, bin, join(fixture, "run", "lock")])
    mkdirSync(path, { recursive: true })
  chmodSync(backup, 0o700)
  for (const path of [lock, dockerState, dockerMutations, volumeMarker])
    writeFileSync(path, "unchanged\n")
  writeFileSync(counter, "99\n")
  writeFileSync(config, "services: {}\n")
  writeFileSync(envFile, "MEDIA_SIDECAR_MODE=rust\n")

  for (const path of [lock, counter, config, envFile]) chmodSync(path, 0o600)
  writeFileSync(ownerPath, owner)
  chmodSync(ownerPath, 0o700)
  installOwnerAdapters(bin)

  const addArchive = ({ generation, state = "committed", restoreState, ageMs = 8 * day }) => {
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
    mkdirSync(run, { mode: 0o700 })
    writeFileSync(join(run, "compose.yaml"), compose)
    writeFileSync(join(run, "deploy.env"), env)
    const manifest = {
      schema: "discord-music-deploy-lease.v1",
      runId,
      generation,
      selectedSha,
      kind: "deployment",
      configPath: config,
      workingDir: deploy,
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
    const restored = state === "expired" && (restoreState ?? "restored") === "restored"
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
      restoreState: restoreState ?? (restored ? "restored" : "idle"),
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
    for (const file of ["compose.yaml", "deploy.env", "manifest.json", "terminal.json"])
      chmodSync(join(run, file), 0o600)
    writeFileSync(
      dockerState,
      `${readFileSync(dockerState, "utf8")}${serverTag}\t${serverImage}\t${priorGit}\n${serverImage}\t${serverImage}\t${priorGit}\n${sidecarTag}\t${sidecarImage}\t${priorGit}\n${sidecarImage}\t${sidecarImage}\t${priorGit}\n`,
    )
    const old = new Date(Date.now() - ageMs)
    utimesSync(run, old, old)
    return { manifest, terminal, run, runId, serverImage }
  }
  const setLease = (archive, mutate = () => {}) => {
    const value = structuredClone(archive.terminal)
    mutate(value)
    writeFileSync(lease, JSON.stringify(value))
    chmodSync(lease, 0o600)
    return value
  }
  const replacementEnvironment = (value) => {
    const path = join(fixture, "replacement-lease.json")
    writeFileSync(path, value)
    chmodSync(path, 0o600)
    return { REPLACE_LEASE_WITH: path }
  }
  const invoke = (environment = {}) =>
    spawnSync("bash", [ownerPath, "begin-run"], {
      encoding: "utf8",
      env: {
        ...process.env,
        MEDIA_OWNER_TEST_ROOT: fixture,
        MEDIA_OWNER_TEST_UID: String(process.getuid()),
        MEDIA_SELECTED_SHA: hex("8", 40),
        MEDIA_OWNER_B64: Buffer.from("#!/usr/bin/env bash\nexit 0\n").toString("base64"),
        MEDIA_COMPOSE_PROJECT: "deploy",
        TEST_CONFIG: config,
        TEST_LOCK: lock,
        DOCKER_STATE: dockerState,
        DOCKER_MUTATIONS: dockerMutations,
        LEASE_PATH: lease,
        REPLACEMENT_MARKER: replacementMarker,
        PATH: `${bin}:${process.env.PATH}`,
        ...environment,
      },
    })
  const initialCurrent = addArchive({ generation: 99, ageMs: 60_000 })
  setLease(initialCurrent)
  try {
    callback({
      addArchive,
      backup,
      config,
      counter,
      dockerState,
      dockerMutations,
      envFile,
      injectionMarker,
      initialCurrent,
      invoke,
      lease,
      replacementMarker,
      replaceLeaseDuringDocker: replacementEnvironment,
      replaceLeaseAtPhase: (value, phase) => {
        const environment = replacementEnvironment(value)
        return { ...environment, MEDIA_OWNER_TEST_REPLACE_PHASE: phase }
      },
      killAtPhase: (phase) => ({ MEDIA_OWNER_TEST_KILL_PHASE: phase }),
      replaceCurrentWithSymlink: () => {
        const sentinel = join(fixture, "external-sentinel")
        mkdirSync(sentinel, { mode: 0o700 })
        writeFileSync(join(sentinel, "untouched"), "sentinel\n")
        rmSync(initialCurrent.run, { recursive: true })
        symlinkSync(sentinel, initialCurrent.run)
        return sentinel
      },
      setLease,
      volumeMarker,
      exists: existsSync,
      read: (path) => readFileSync(path, "utf8"),
      write: (path, value) => writeFileSync(path, value),
    })
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}
