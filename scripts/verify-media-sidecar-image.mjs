#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { localVerify } from "./verify-media-sidecar-image-local.mjs"

const SHA = /^[0-9a-f]{40}$/u
const PROJECT = /^discord-music-sidecar-qa-[0-9a-f]{12}$/u
const COMMAND =
  /^(local-verify|remote-preflight-and-verify|remote-verify|remote-cleanup-assert|remote-inspect)$/u

class VerifierError extends Error {
  constructor(stage) {
    super(stage)
    this.name = "VerifierError"
    this.stage = stage
  }
}

function options(tokens) {
  const values = new Map()
  for (let index = 0; index < tokens.length; index += 1) {
    const key = tokens[index]
    if (!key?.startsWith("--")) throw new VerifierError("arguments")
    const candidate = tokens[index + 1]
    if (candidate !== undefined && !candidate.startsWith("--")) {
      values.set(key.slice(2), candidate)
      index += 1
    } else values.set(key.slice(2), true)
  }
  return values
}

function required(values, name, pattern) {
  const value = values.get(name)
  if (typeof value !== "string" || (pattern !== undefined && !pattern.test(value)))
    throw new VerifierError(`argument-${name}`)
  return value
}

function quote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function run(program, args, stage, input) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  })
  if (result.status !== 0) throw new VerifierError(stage)
  return result.stdout.trim()
}

function sshArgs(values) {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-i",
    required(values, "ssh-key"),
    required(values, "host", /^[a-z]+@[0-9.]+$/u),
  ]
}

function ssh(values, command, stage, input) {
  return run("ssh", [...sshArgs(values), command], stage, input)
}

function assertText(condition, stage) {
  if (!condition) throw new VerifierError(stage)
}

function preflight(values) {
  const key = required(values, "ssh-key")
  assertText((statSync(key).mode & 0o777) === 0o600, "key-mode")
  const lxc = required(values, "lxc", /^[0-9]+$/u)
  const root = required(values, "remote-root", /^\/opt\/discord-music\/\.omo-sidecar-qa$/u)
  const output = ssh(
    values,
    `set -eu; pct status ${lxc}; pct exec ${lxc} -- docker version --format '{{.Server.Version}}'; pct exec ${lxc} -- docker compose version --short; pct exec ${lxc} -- df -Pm /opt/discord-music`,
    "remote-preflight",
  )
  const available = Number(output.split("\n").at(-1)?.trim().split(/\s+/u)[3])
  assertText(
    output.includes("status: running") &&
      Number.isFinite(available) &&
      available >= Number(values.get("min-free-mib") ?? 2048),
    "remote-capacity",
  )
  return { lxc, root }
}

function transfer(values, lxc, root, sha) {
  const directory = mkdtempSync(join(tmpdir(), "media-sidecar-bundle-"))
  const bundle = join(directory, "source.bundle")
  try {
    execFileSync("git", ["bundle", "create", bundle, "HEAD"], { stdio: "ignore" })
    chmodSync(bundle, 0o600)
    const command = `pct exec ${lxc} -- bash -c ${quote('install -d -m 0700 -- "$1"; umask 077; cat >"$1/source.bundle"')} _ ${quote(`${root}/${sha}`)}`
    ssh(values, command, "bundle-transfer", readFileSync(bundle))
  } finally {
    rmSync(directory, { recursive: true })
  }
}

function remoteScript(mode) {
  const script = readFileSync("scripts/verify-media-sidecar-image-remote.sh", "utf8")
  return `export VERIFY_MODE=${quote(mode)}\n${script}`
}

function remoteRun(values, mode) {
  const { lxc, root } = preflight(values)
  const sha = required(values, "sha", SHA)
  const tree = required(values, "tree", SHA)
  const project = required(values, "project", PROJECT)
  localVerify(
    new Map([["compose", required(values, "compose", /^docker-compose\.media-sidecar-qa\.yml$/u)]]),
    required,
    assertText,
  )
  assertText(
    run("git", ["rev-parse", "HEAD"], "local-head") === sha &&
      run("git", ["rev-parse", "HEAD^{tree}"], "local-tree") === tree,
    "checkpoint-mismatch",
  )
  assertText(run("git", ["status", "--porcelain"], "local-status") === "", "dirty-checkpoint")
  transfer(values, lxc, root, sha)
  const env = [
    `CHECKPOINT_SHA=${sha}`,
    `CHECKPOINT_TREE=${tree}`,
    `REMOTE_ROOT=${root}`,
    `PROJECT=${project}`,
    `COMPOSE=${values.get("compose")}`,
  ]
  const result = spawnSync(
    "ssh",
    [...sshArgs(values), `pct exec ${lxc} -- env ${env.map(quote).join(" ")} bash -se`],
    {
      encoding: "utf8",
      input: remoteScript(mode),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    },
  )
  const expected = mode === "drain" ? 86 : 0
  if (
    result.status !== expected ||
    !result.stdout.includes("cleanup=true") ||
    !result.stdout.includes(`checkpoint=${sha}`)
  ) {
    const failure = result.stdout.match(/failure_stage=([a-z-]+)/u)?.[1] ?? "unknown"
    const saturation = ["four_latched", "deno_latched", "environment_observed"]
      .map((name) => result.stdout.match(new RegExp(`${name}=([a-z-]+)`, "u"))?.[1] ?? "unknown")
      .join("-")
    throw new VerifierError(`remote-${failure}-${saturation}`)
  }
  return result.stdout.trim()
}

function cleanupAssert(values) {
  const { lxc, root } = preflight(new Map([...values, ["min-free-mib", "0"]]))
  const sha = required(values, "sha", SHA)
  const project = required(values, "project", PROJECT)
  const command = `pct exec ${lxc} -- bash -ceu ${quote('test ! -e "$1"; test -z "$(docker ps -aq --filter label=com.docker.compose.project=$2)"; test -z "$(docker network ls -q --filter label=com.docker.compose.project=$2)"; test -z "$(docker volume ls -q --filter label=com.docker.compose.project=$2)"')} _ ${quote(`${root}/${sha}`)} ${quote(project)}`
  ssh(values, command, "cleanup-assert")
  return { cleanup: true }
}

function remoteInspect(values) {
  const key = required(values, "ssh-key")
  assertText((statSync(key).mode & 0o777) === 0o600, "key-mode")
  const lxc = required(values, "lxc", /^[0-9]+$/u)
  const sha = required(values, "sha", SHA)
  const repository = required(values, "repo", /^\/opt\/discord-music$/u)
  const command = `pct exec ${lxc} -- env ${quote(`CHECKPOINT_SHA=${sha}`)} ${quote(`PRODUCTION_REPO=${repository}`)} bash -se`
  const output = ssh(values, command, "production-inspect", remoteScript("inspect"))
  assertText(output.includes(`checkpoint=${sha}`), "production-checkpoint")
  return output
}

function main() {
  const command = process.argv[2]
  if (command === undefined || !COMMAND.test(command)) throw new VerifierError("command")
  const values = options(process.argv.slice(3))
  if (command === "local-verify") return localVerify(values, required, assertText)
  if (command === "remote-preflight-and-verify") return remoteRun(values, "smoke")
  if (command === "remote-verify") {
    if (values.get("expect-injected-failure") !== true)
      throw new VerifierError("expected-failure-flag")
    const result = remoteRun(values, "drain")
    cleanupAssert(values)
    return result
  }
  if (command === "remote-cleanup-assert") return cleanupAssert(values)
  return remoteInspect(values)
}

try {
  const result = main()
  if (typeof result === "string") process.stdout.write(`${result}\n`)
  else process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
} catch (error) {
  const stage = error instanceof VerifierError ? error.stage : "internal"
  process.stderr.write(`${JSON.stringify({ ok: false, stage })}\n`)
  process.exitCode = 1
}
