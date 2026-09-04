#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SHA = /^[0-9a-f]{40}$/u
const PROJECT = /^discord-music-sidecar-qa-[0-9a-f]{12}$/u
const COMMANDS = new Set([
  "local-verify",
  "remote-preflight-and-verify",
  "remote-verify",
  "remote-cleanup-assert",
  "remote-inspect",
])

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

function localVerify(values) {
  const media = readFileSync("Dockerfile.media-sidecar", "utf8")
  const compose = readFileSync(
    required(values, "compose", /^docker-compose\.media-sidecar-qa\.yml$/u),
    "utf8",
  )
  const production = readFileSync("docker-compose.yml", "utf8")
  const ignore = readFileSync(".dockerignore", "utf8")
  const resolve = readFileSync("apps/media-sidecar/src/resolve.rs", "utf8")
  const process = readFileSync("apps/media-sidecar/src/process.rs", "utf8")
  const pins = [
    "rust:1.98.0-bookworm@sha256:e536cf316987faedfe8ae120f83b70c7df0068fdb4fc9efcce55c71a625001d5",
    "debian:bookworm-20260824-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171",
    "tini=0.19.0-1+b3",
    "58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a",
    "8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530",
    'ENTRYPOINT ["/usr/bin/tini","-s","--"]',
  ]
  assertText(
    pins.every((pin) => media.includes(pin)),
    "static-pins",
  )
  assertText(
    !/\b(node|bun|quickjs|ffmpeg)\b/iu.test(media) && !media.includes("test-upstream"),
    "static-sidecar-denylist",
  )
  assertText(
    compose.match(/^ {2}[a-z][a-z-]*:/gmu)?.join(",") === "  media-sidecar:,  probe:",
    "static-service-allowlist",
  )
  assertText(
    !/^\s+(ports|volumes|env_file|secrets|configs):/mu.test(compose) &&
      !/external:\s*true/u.test(compose),
    "static-resource-denylist",
  )
  assertText(
    compose.includes("qa-${CHECKPOINT_SHA:?") &&
      production.includes("MEDIA_SIDECAR_URL: http://media-sidecar:3101"),
    "static-private-wiring",
  )
  assertText(
    !compose.includes("--allow-net") && !production.includes("--allow-net"),
    "static-deno-health",
  )
  const sidecarService = production.split("\n  media-sidecar:")[1]?.split("\n  dashboard:")[0] ?? ""
  assertText(
    sidecarService.includes('expose:\n      - "3101"') && !/^\s+ports:/mu.test(sidecarService),
    "static-no-publish",
  )
  assertText(
    [".git", ".omo", "secrets/", "**/target/", "*cookies*"].every((entry) =>
      ignore.includes(entry),
    ),
    "static-context-denylist",
  )
  assertText(
    resolve.includes('"--proxy".into(),\n        "".into()') &&
      resolve.includes('"deno:/usr/local/bin/deno".into()'),
    "static-fixed-extractor",
  )
  const childKeys = [...process.matchAll(/\.env\("([A-Z_]+)"/gu)]
    .map((match) => match[1])
    .sort()
    .join(",")
  assertText(
    process.includes(".env_clear()") && childKeys === "HOME,LANG,LC_ALL,PATH,SSL_CERT_FILE,TMPDIR",
    "static-child-environment",
  )
  return { static: true }
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
  if (result.status !== expected || !result.stdout.includes("cleanup=true")) {
    const failure = result.stdout.match(/failure_stage=([a-z-]+)/u)?.[1] ?? "unknown"
    throw new VerifierError(`remote-${failure}`)
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

function main() {
  const command = process.argv[2]
  if (command === undefined || !COMMANDS.has(command)) throw new VerifierError("command")
  const values = options(process.argv.slice(3))
  if (command === "local-verify") return localVerify(values)
  if (command === "remote-preflight-and-verify") return remoteRun(values, "smoke")
  if (command === "remote-verify") {
    if (values.get("expect-injected-failure") !== true)
      throw new VerifierError("expected-failure-flag")
    remoteRun(values, "drain")
    return cleanupAssert(values)
  }
  if (command === "remote-cleanup-assert") return cleanupAssert(values)
  throw new VerifierError("remote-inspect-not-available-before-deployment")
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
