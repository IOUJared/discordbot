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

export const SIZE_PATHS = [
  "apps/media-sidecar/tests/http_contract.rs",
  "apps/media-sidecar/tests/http_failures.rs",
  "apps/media-sidecar/tests/http_shutdown.rs",
  "apps/media-sidecar/tests/search.rs",
  "apps/media-sidecar/tests/search_benchmark.rs",
  "apps/media-sidecar/tests/search_transport.rs",
  "apps/media-sidecar/tests/support/http_contract.rs",
  "apps/media-sidecar/tests/support/search.rs",
  "apps/server/tests/media/youtube-sidecar-client.test.ts",
  "apps/server/tests/media/youtube-sidecar-client-errors.test.ts",
  "apps/server/tests/media/youtube-sidecar-client-transport.test.ts",
  "apps/server/tests/media/youtube-sidecar-client.test-helpers.ts",
  "apps/server/tests/media/youtube.test.ts",
  "apps/server/tests/media/youtube-resolve.test.ts",
  "apps/server/tests/media/youtube-search-cache.test.ts",
  "apps/server/tests/media/youtube-search-preload.test.ts",
  "apps/server/tests/media/youtube.test-helpers.ts",
  "scripts/media-sidecar-integration.mjs",
  "scripts/media-sidecar-integration.test.mjs",
  "scripts/media-sidecar-integration-test-support.mjs",
  "scripts/media-sidecar-attestation.cases.mjs",
  "scripts/media-sidecar-audit.mjs",
  "scripts/media-sidecar-inspection.cases.mjs",
  "scripts/media-sidecar-storage.cases.mjs",
  "scripts/media-sidecar-lease.cases.mjs",
  "scripts/media-sidecar-quality-attestation.mjs",
  "scripts/media-sidecar-quality-boundaries.mjs",
]

export const SOURCE_PATHS = [
  "Dockerfile.media-sidecar",
  "apps/media-sidecar/Cargo.toml",
  "apps/media-sidecar/rust-toolchain.toml",
  "apps/media-sidecar/src/http.rs",
  "apps/media-sidecar/src/observation.rs",
  "apps/media-sidecar/src/operations.rs",
  "apps/media-sidecar/src/process.rs",
  "apps/media-sidecar/src/search.rs",
  "apps/server/src/media/youtube-sidecar-client.ts",
  "apps/server/src/media/youtube-sidecar-observation.ts",
  "apps/server/src/media/youtube.ts",
  "deploy/compose.yaml",
  "scripts/media-sidecar-remote-rollback.sh",
  "scripts/verify-media-sidecar-image-remote.sh",
  ...SIZE_PATHS,
]

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
        /begin_run\(\)[\s\S]+mv "\$temp" "\$run"; sync -f "\$MS_BACKUP"/u,
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
