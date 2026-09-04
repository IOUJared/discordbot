import { existsSync, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const REQUIRED_BOUNDARIES = [
  "bounds",
  "supervised-cancellation",
  "direct-no-redirect-http",
  "private-observation",
  "redacted-logs",
  "pins",
  "watchdog-cas-fencing",
  "atomic-begin-run",
  "daemon-convergence",
]

const EXACT_SOURCE_PATHS = new Set([
  "Dockerfile.media-sidecar",
  "apps/media-sidecar/Cargo.toml",
  "apps/media-sidecar/rust-toolchain.toml",
  "apps/media-sidecar/build.rs",
  "apps/server/src/api/state-routes.ts",
  "apps/server/src/app.ts",
  "apps/server/src/config.ts",
  "apps/server/src/runtime/production.ts",
  "apps/server/tests/api/config.test.ts",
  "apps/server/tests/runtime/runtime.test.ts",
  "deploy/compose.yaml",
])

const SOURCE_ROOTS = [
  "apps/media-sidecar/src",
  "apps/media-sidecar/tests",
  "apps/server/src/media",
  "apps/server/tests/media",
  "scripts",
  "spec/media-sidecar/v1",
]

export const SIZE_EXEMPT_PATHS = new Set(["scripts/media-sidecar-remote-rollback.sh"])

export function isMigrationSourcePath(path) {
  return (
    EXACT_SOURCE_PATHS.has(path) ||
    path.startsWith("apps/media-sidecar/src/") ||
    path.startsWith("apps/media-sidecar/tests/") ||
    path.startsWith("apps/server/src/media/") ||
    path.startsWith("apps/server/tests/media/") ||
    path.startsWith("spec/media-sidecar/v1/") ||
    /^scripts\/(?:media-sidecar|verify-media-sidecar).*(?:\.mjs|\.sh)$/u.test(path)
  )
}

export function discoverSourcePaths(root) {
  const paths = [...EXACT_SOURCE_PATHS].filter((path) => existsSync(join(root, path)))
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) {
        const path = relative(root, absolute).split(sep).join("/")
        if (isMigrationSourcePath(path)) paths.push(path)
      }
    }
  }
  for (const path of SOURCE_ROOTS) {
    const directory = join(root, path)
    if (existsSync(directory)) visit(directory)
  }
  return paths.sort()
}

export const SOURCE_PATHS = discoverSourcePaths(fileURLToPath(new URL("../", import.meta.url)))

export const PROOFS = new Map([
  [
    "bounds",
    [
      ["apps/media-sidecar/src/http.rs", /MAXIMUM_REQUEST_BYTES: usize = 16 \* 1024/u],
      ["apps/media-sidecar/src/search.rs", /MAXIMUM_RESPONSE_BYTES: usize = 1024 \* 1024/u],
      ["apps/media-sidecar/src/operations.rs", /EXTRACTOR_PERMITS: usize = 4/u],
      ["apps/server/src/media/youtube-sidecar-client.ts", /RESPONSE_LIMIT_BYTES = 1_048_576/u],
    ],
  ],
  [
    "supervised-cancellation",
    [
      [
        "apps/media-sidecar/src/process.rs",
        /\.process_group\(0\)[\s\S]+kill_group\(process_group\)/u,
      ],
      [
        "apps/media-sidecar/src/operations.rs",
        /fn shutdown[\s\S]+token\.cancel\(\)[\s\S]+join_next/u,
      ],
      [
        "apps/server/src/media/youtube-sidecar-client.ts",
        /addEventListener\("abort"[\s\S]+finally/u,
      ],
    ],
  ],
  [
    "direct-no-redirect-http",
    [
      ["apps/media-sidecar/src/search.rs", /\.no_proxy\(\)[\s\S]+\.redirect\(Policy::none\(\)\)/u],
      ["apps/server/src/media/youtube-sidecar-client.ts", /redirect: "manual"[\s\S]+undiciFetch/u],
    ],
  ],
  [
    "private-observation",
    [
      ["apps/media-sidecar/src/observation.rs", /SCHEMA: &str = "media_sidecar_observation\.v1"/u],
      [
        "apps/server/src/media/youtube-sidecar-observation.ts",
        /MEDIA_SIDECAR_OBSERVATION_SCHEMA = "media_sidecar_observation\.v1"/u,
      ],
      ["deploy/compose.yaml", /media-sidecar:[\s\S]+expose: \["3101"\]/u],
    ],
  ],
  [
    "redacted-logs",
    [
      [
        "apps/server/src/media/youtube-sidecar-observation.ts",
        /randomBytes\(32\)[\s\S]+createHmac\("sha256", observationSalt\)/u,
      ],
      [
        "apps/media-sidecar/src/observation.rs",
        /struct ObservationEvent \{[\s\S]+counter_delta: CounterDelta,/u,
      ],
    ],
  ],
  [
    "pins",
    [
      ["apps/media-sidecar/rust-toolchain.toml", /channel = "1\.98\.0"/u],
      ["apps/media-sidecar/Cargo.toml", /axum = \{ version = "=0\.8\.9"/u],
      ["Dockerfile.media-sidecar", /rust:1\.98\.0-bookworm@sha256:e536cf[0-9a-f]+/u],
      [
        "Dockerfile.media-sidecar",
        /yt-dlp\/releases\/download\/2026\.08\.19[\s\S]+58162f9bfdc27458e/u,
      ],
      ["Dockerfile.media-sidecar", /deno\/releases\/download\/v2\.9\.5[\s\S]+8b010a3b1a4a0188/u],
    ],
  ],
  [
    "watchdog-cas-fencing",
    [
      [
        "scripts/media-sidecar-remote-rollback.sh",
        /cas_active\(\)[\s\S]+wrong-run[\s\S]+stale-sequence/u,
      ],
      ["scripts/media-sidecar-remote-rollback.sh", /nohup setsid "\$run\/owner\.sh" watchdog/u],
      ["scripts/media-sidecar-remote-rollback.sh", /activeMutation[\s\S]+acceptedOperations/u],
    ],
  ],
  [
    "atomic-begin-run",
    [
      [
        "scripts/media-sidecar-remote-rollback.sh",
        /atomic_file\(\)[\s\S]+sync -f "\$temp"[\s\S]+mv -f "\$temp" "\$target"/u,
      ],
      [
        "scripts/media-sidecar-remote-rollback.sh",
        /validate_begin_recovery_paths_locked\(\)[\s\S]+recover_begin_runs_locked\(\)[\s\S]+max_generation[\s\S]+allocate_generation_locked\(\)[\s\S]+os\.replace\(staged, counter\)[\s\S]+publish_begin_run_locked\(\)[\s\S]+os\.replace\(temp, run\)[\s\S]+os\.replace\(lease_staged, lease\)[\s\S]+publish_begin_run_locked "\$temp" "\$run"/u,
      ],
    ],
  ],
  [
    "daemon-convergence",
    [
      [
        "scripts/media-sidecar-remote-rollback.sh",
        /restore_locked\(\)[\s\S]+sample1[\s\S]+sample2[\s\S]+event_count/u,
      ],
      [
        "scripts/media-sidecar-remote-rollback.sh",
        /lateDaemonDetected=true[\s\S]+reconcilePasses \+= 1/u,
      ],
      ["scripts/media-sidecar-remote-rollback.sh", /quietWindowEvents:0/u],
    ],
  ],
])
