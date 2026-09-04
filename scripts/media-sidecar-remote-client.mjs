import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SHA = /^[0-9a-f]{40}$/u
const RUN_ID = /^[1-9][0-9]*-[0-9a-f]{32}$/u
export const INTEGRATION_COMMAND =
  /^(preflight|recovery-drill|deploy-live|final-production-qa|audit-plan|attest-code-quality|audit-scope)$/u

export class RemoteError extends Error {
  constructor(stage, detail = "") {
    super(stage)
    this.name = "RemoteError"
    this.stage = stage
    this.detail = detail
  }
}

function quote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function assertValue(condition, stage) {
  if (!condition) throw new RemoteError(stage)
}

function parseJson(output, stage) {
  const line = output.trim().split("\n").at(-1)
  try {
    const value = JSON.parse(line ?? "")
    assertValue(value.ok === true, stage)
    return value
  } catch (error) {
    if (error instanceof RemoteError) throw error
    throw new RemoteError(stage)
  }
}

export function parseOptions(tokens) {
  const values = new Map()
  for (let index = 0; index < tokens.length; index += 1) {
    const key = tokens[index]
    if (key === undefined || !key.startsWith("--")) throw new RemoteError("arguments")
    const next = tokens[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key.slice(2), next)
      index += 1
    } else values.set(key.slice(2), true)
  }
  return values
}

export function required(values, name, pattern) {
  const value = values.get(name)
  if (typeof value !== "string" || (pattern !== undefined && !pattern.test(value)))
    throw new RemoteError(`argument-${name}`)
  return value
}

export function redactRunId(runId) {
  return runId.replace(/-[0-9a-f]{32}$/u, "-<redacted>")
}

export class RemoteClient {
  constructor(values) {
    this.key = required(values, "ssh-key")
    this.host = required(values, "host", /^root@[0-9.]+$/u)
    this.lxc = required(values, "lxc", /^115$/u)
    this.repo = required(values, "repo", /^\/opt\/discord-music$/u)
    this.backup = String(values.get("backup-root") ?? "/root/discord-music-rollbacks")
    this.lock = String(values.get("lock-file") ?? "/run/lock/discord-music-deploy.lock")
    this.lease = String(values.get("lease-file") ?? `${this.backup}/active.json`)
    this.counter = String(values.get("run-counter") ?? `${this.backup}/run-counter`)
    this.ownerPath = new URL("./media-sidecar-remote-rollback.sh", import.meta.url)
    this.owner = readFileSync(this.ownerPath)
    assertValue((statSync(this.key).mode & 0o777) === 0o600, "key-mode")
    assertValue(this.lock === "/run/lock/discord-music-deploy.lock", "lock-path")
    assertValue(this.backup === "/root/discord-music-rollbacks", "backup-path")
    assertValue(this.lease === `${this.backup}/active.json`, "lease-path")
    assertValue(this.counter === `${this.backup}/run-counter`, "counter-path")
  }

  sshArgs(command) {
    return [
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ConnectTimeout=10",
      "-i",
      this.key,
      this.host,
      command,
    ]
  }

  baseEnvironment(sha, extra = {}) {
    return {
      MEDIA_REPO: this.repo,
      MEDIA_BACKUP_ROOT: this.backup,
      MEDIA_LOCK_FILE: this.lock,
      MEDIA_LEASE_FILE: this.lease,
      MEDIA_RUN_COUNTER: this.counter,
      MEDIA_SELECTED_SHA: sha,
      ...extra,
    }
  }

  remoteCommand(environment, executable) {
    const env = Object.entries(environment)
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join(" ")
    return `pct exec ${this.lxc} -- env ${env} ${executable}`
  }

  run(command, { input, timeout = 30_000, stage = command } = {}) {
    const result = spawnSync("ssh", this.sshArgs(command), {
      input,
      encoding: input instanceof Buffer ? undefined : "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout,
    })
    if (result.status !== 0) {
      const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr
      const safe = stderr?.match(/\{"ok":false,"stage":"[a-z0-9-]+"\}/u)?.[0] ?? ""
      throw new RemoteError(stage, safe)
    }
    return Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout
  }

  hostPreflight() {
    const command = `set -eu; test "$(pct status ${this.lxc})" = "status: running"; pct exec ${this.lxc} -- test -d ${quote(this.repo)}; pct exec ${this.lxc} -- docker info >/dev/null; printf '{"ok":true,"proxmox":true,"lxc":115}\n'`
    return parseJson(this.run(command, { stage: "host-preflight" }), "host-preflight")
  }

  preflight(sha = "") {
    this.hostPreflight()
    const env = this.baseEnvironment(sha, { MEDIA_MIN_FREE_MIB: "2048" })
    const command = this.remoteCommand(env, "bash -s -- preflight")
    return parseJson(this.run(command, { input: this.owner, stage: "preflight" }), "preflight")
  }

  begin(sha, kind, deadlineSeconds) {
    assertValue(SHA.test(sha), "selected-sha")
    const env = this.baseEnvironment(sha, {
      MEDIA_OWNER_B64: this.owner.toString("base64"),
      MEDIA_RUN_KIND: kind,
      MEDIA_DEADLINE_SECONDS: String(deadlineSeconds),
    })
    const command = this.remoteCommand(env, "bash -s -- begin-run")
    const run = parseJson(this.run(command, { input: this.owner, stage: "begin-run" }), "begin-run")
    assertValue(typeof run.runId === "string" && RUN_ID.test(run.runId), "run-id")
    assertValue(run.sequence === 0 && Number.isSafeInteger(run.generation), "run-sequence")
    return run
  }

  ownerCommand(sha, runId, suffix) {
    assertValue(SHA.test(sha) && RUN_ID.test(runId), "owner-command")
    const owner = `${this.backup}/${runId}/owner.sh`
    return this.remoteCommand(this.baseEnvironment(sha), `${quote(owner)} ${suffix}`)
  }

  mutate({ sha, runId, sequence, operation, input, timeout = 30 * 60 * 1_000 }) {
    const command = this.ownerCommand(
      sha,
      runId,
      `mutate ${quote(runId)} ${sequence} ${quote(operation)}`,
    )
    return parseJson(
      this.run(command, { input, timeout, stage: `mutate-${operation}` }),
      `mutate-${operation}`,
    )
  }

  startDisconnectedMutation({ sha, runId, sequence, operation }) {
    const command = this.ownerCommand(
      sha,
      runId,
      `mutate ${quote(runId)} ${sequence} ${quote(operation)}`,
    )
    const child = spawn("ssh", this.sshArgs(command), { stdio: "ignore", detached: false })
    return child
  }

  state(sha, runId) {
    const command = this.ownerCommand(sha, runId, "state")
    return parseJson(this.run(command, { stage: "state" }), "state")
  }

  waitRestored(sha, runId, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = this.state(sha, runId)
      if (state.state === "expired" && state.restoreState === "restored") return state
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000)
    }
    throw new RemoteError("restore-timeout")
  }

  commit(sha, runId, sequence) {
    const command = this.ownerCommand(sha, runId, `commit ${quote(runId)} ${sequence}`)
    return parseJson(this.run(command, { stage: "commit" }), "commit")
  }

  expire(sha, runId) {
    const command = this.ownerCommand(sha, runId, `expire ${quote(runId)}`)
    return parseJson(this.run(command, { timeout: 180_000, stage: "expire" }), "expire")
  }

  bundle() {
    const directory = mkdtempSync(join(tmpdir(), "discord-music-deploy-"))
    const path = join(directory, "source.bundle")
    const result = spawnSync("git", ["bundle", "create", path, "HEAD"], { stdio: "ignore" })
    if (result.status !== 0) throw new RemoteError("bundle")
    chmodSync(path, 0o600)
    return { bytes: readFileSync(path), cleanup: () => rmSync(directory, { recursive: true }) }
  }
}
