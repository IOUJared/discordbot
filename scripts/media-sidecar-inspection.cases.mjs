import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("production inspection selects the live Compose config from container labels", () => {
  // Given: production is launched as project `deploy` from deploy/compose.yaml.
  const script = readFileSync(
    new URL("./verify-media-sidecar-image-remote.sh", import.meta.url),
    "utf8",
  )
  const inspect = script.slice(0, script.indexOf("exit 0\nfi"))

  // When/Then: inspection discovers the actual project/config and scopes every lookup to both.
  assert.match(inspect, /com\.docker\.compose\.project=deploy/u)
  assert.match(inspect, /com\.docker\.compose\.project\.config_files/u)
  assert.match(inspect, /docker compose -p "\$project" -f "\$config" ps -q media-sidecar/u)
})

test("production inspection requests a Docker-compatible PID process table", () => {
  const inspector = readFileSync(
    new URL("./verify-media-sidecar-image-remote.sh", import.meta.url),
    "utf8",
  )
  const inspect = inspector.slice(0, inspector.indexOf("exit 0\nfi"))
  assert.match(inspect, /docker top "\$sidecar" -eo pid,stat,comm/u)
})
