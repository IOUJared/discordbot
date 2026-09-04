import { readFileSync } from "node:fs"

export function localVerify(values, required, assertText) {
  const media = readFileSync("Dockerfile.media-sidecar", "utf8")
  const compose = readFileSync(
    required(values, "compose", /^docker-compose\.media-sidecar-qa\.yml$/u),
    "utf8",
  )
  const production = readFileSync("docker-compose.yml", "utf8")
  const deployment = readFileSync("deploy/compose.yaml", "utf8")
  const ignore = readFileSync(".dockerignore", "utf8")
  const resolve = readFileSync("apps/media-sidecar/src/resolve.rs", "utf8")
  const process = readFileSync("apps/media-sidecar/src/process.rs", "utf8")
  const remote = readFileSync("scripts/verify-media-sidecar-image-remote.sh", "utf8")
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
      production.includes("MEDIA_SIDECAR_URL: http://media-sidecar:3101") &&
      deployment.includes("MEDIA_SIDECAR_URL: http://media-sidecar:3101"),
    "static-private-wiring",
  )
  assertText(
    !compose.includes("--allow-net") && !production.includes("--allow-net"),
    "static-deno-health",
  )
  const sidecarService = production.split("\n  media-sidecar:")[1]?.split("\n  dashboard:")[0] ?? ""
  const deployedServer = deployment.match(/\n  server:\n([\s\S]+?)(?=\n  [a-z][a-z-]*:|\nvolumes:)/u)?.[1] ?? ""
  const deployedSidecar =
    deployment.match(/\n  media-sidecar:\n([\s\S]+?)(?=\n  [a-z][a-z-]*:|\nvolumes:)/u)?.[1] ?? ""
  assertText(
    sidecarService.includes('expose:\n      - "3101"') && !/^\s+ports:/mu.test(sidecarService),
    "static-no-publish",
  )
  assertText(
    deployedServer !== "" &&
      deployedSidecar !== "" &&
      !/\n    depends_on:/u.test(deployedServer) &&
      !/\n    links:/u.test(deployedServer) &&
      deployedSidecar.includes('expose: ["3101"]') &&
      !/\n    ports:/u.test(deployedSidecar),
    "static-independent-node-startup",
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
  assertText(
    !/docker compose[^\n]* exec/u.test(remote) && remote.includes("checkpoint=%s"),
    "static-noninteractive-remote",
  )
  return { static: true }
}
