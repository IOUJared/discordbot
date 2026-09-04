import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const compose = readFileSync(new URL("../deploy/compose.yaml", import.meta.url), "utf8")
const server = compose.match(/\n  server:\n([\s\S]+?)(?=\n  [a-z][a-z-]*:|\nvolumes:)/u)?.[1] ?? ""
const sidecar =
  compose.match(/\n  media-sidecar:\n([\s\S]+?)(?=\n  [a-z][a-z-]*:|\nvolumes:)/u)?.[1] ?? ""

test("production Node startup has no sidecar health gate or legacy link", () => {
  assert.match(server, /MEDIA_SIDECAR_URL: http:\/\/media-sidecar:3101/u)
  assert.doesNotMatch(server, /\n    depends_on:/u)
  assert.doesNotMatch(server, /\n    links:/u)
})

test("production sidecar remains private on the Compose network", () => {
  assert.match(sidecar, /\n    expose: \["3101"\]/u)
  assert.doesNotMatch(sidecar, /\n    ports:/u)
})
