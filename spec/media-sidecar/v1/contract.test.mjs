import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = new URL(".", import.meta.url)
const path = (relative) => resolve(root.pathname, relative)
const json = (relative) => JSON.parse(readFileSync(path(relative), "utf8"))
const sha256 = (relative) => createHash("sha256").update(readFileSync(path(relative))).digest("hex")
const keys = (value) => Object.keys(value).sort()
const exactKeys = (value, expected) => assert.deepEqual(keys(value), [...expected].sort())
const canonicalUrl = (id) => `https://www.youtube.com/watch?v=${id}`
const errorCodes = new Map([
  [400, "invalid_request"],
  [413, "payload_too_large"],
  [415, "unsupported_media_type"],
  [429, "busy"],
  [500, "internal"],
  [502, "extractor_failed"],
  [504, "deadline_exceeded"],
])
const parserTests = [
  "parses a search fixture into shared tracks",
  "Given selected audio formats When search metadata is parsed Then higher bitrates rank first",
  "rejects malformed external JSON",
  "derives YouTube artwork when flat search omits a thumbnail",
  "ranks a verified official artist upload above an unofficial copy",
  "collapses duplicate audio video and lyric uploads of the same song",
  "keeps meaningful alternate versions as separate choices",
]

function validateTrack(track) {
  exactKeys(track, ["id", "provider", "title", "artist", "url", "durationMs", "artworkUrl"])
  assert.equal(track.provider, "youtube")
  assert.match(track.id, /^[A-Za-z0-9_-]{1,128}$/u)
  assert.equal(track.url, canonicalUrl(track.id))
  assert.ok(Number.isInteger(track.durationMs) && track.durationMs >= 0)
}

function validateResult(result) {
  exactKeys(result, ["track", "score", "bitrateKbps"])
  validateTrack(result.track)
  assert.ok(result.score >= 0 && result.score <= 1)
  assert.ok(result.bitrateKbps === null || (Number.isInteger(result.bitrateKbps) && result.bitrateKbps > 0))
}

function validateEnvelope(fixture, status, code) {
  assert.equal(fixture.status, status)
  assert.equal(fixture.contentType, "application/json")
  exactKeys(fixture.body, ["version", "error"])
  assert.equal(fixture.body.version, 1)
  exactKeys(fixture.body.error, ["code"])
  assert.equal(fixture.body.error.code, code)
}

function validateManifest(manifest) {
  exactKeys(manifest, ["version", "raw", "parserMigration"])
  assert.equal(manifest.version, 1)
  assert.equal(manifest.raw.length, new Set(manifest.raw.map(({ path: itemPath }) => itemPath)).size)
  for (const item of manifest.raw) {
    exactKeys(item, ["path", "sha256", "sourceKind", "classification", "nodeConsumer", "rustConsumer", "expected"])
    assert.equal(item.classification, "useful")
    assert.match(item.sha256, /^[a-f0-9]{64}$/u)
    assert.equal(sha256(item.path), item.sha256, `raw hash drift: ${item.path}`)
    assert.match(item.nodeConsumer, /^planned:/u)
    assert.match(item.rustConsumer, /^planned:/u)
    assert.ok(["innertube", "yt-dlp"].includes(item.sourceKind))
    exactKeys(item.expected, item.expected.outcome === "response" ? ["outcome", "fixture"] : ["outcome", "code"])
    if (item.expected.outcome === "response") {
      assert.match(item.expected.fixture, /^fixtures\/responses\/.+\.json$/u)
      assert.ok(json(item.expected.fixture))
    } else {
      assert.equal(item.expected.outcome, "error")
      assert.equal(item.expected.code, "invalid_resolve_output")
    }
  }
  assert.deepEqual(manifest.parserMigration.map(({ sourceTest }) => sourceTest), parserTests)
  for (const entry of manifest.parserMigration) {
    exactKeys(entry, ["sourceTest", "classification", "rationale"])
    assert.equal(entry.classification, "implementation-only")
    assert.match(entry.rationale, /obsolete|replaced/u)
  }
}

function validateProtocolFixtures() {
  const searchRequest = json("fixtures/requests/search.json")
  exactKeys(searchRequest, ["version", "query"])
  assert.equal(searchRequest.version, 1)
  assert.ok(typeof searchRequest.query === "string" && searchRequest.query.length >= 1)

  const resolveRequest = json("fixtures/requests/resolve.json")
  exactKeys(resolveRequest, ["version", "track"])
  assert.equal(resolveRequest.version, 1)
  exactKeys(resolveRequest.track, ["id", "url"])
  assert.equal(resolveRequest.track.url, canonicalUrl(resolveRequest.track.id))

  const response = json("fixtures/responses/search-ordinal.json")
  exactKeys(response, ["version", "results"])
  assert.equal(response.version, 1)
  for (const result of response.results) validateResult(result)

  const resolved = json("fixtures/responses/resolve.json")
  exactKeys(resolved, ["version", "media"])
  assert.equal(resolved.version, 1)
  exactKeys(resolved.media, ["kind", "url", "headers", "container", "codec", "bitrateKbps", "seekable"])
  assert.equal(resolved.media.kind, "remote")
  assert.equal(resolved.media.seekable, true)

  for (const [status, code] of errorCodes) validateEnvelope(json(`fixtures/errors/${status}.json`), status, code)
  assert.deepEqual(json("fixtures/errors/413.json").body, { version: 1, error: { code: "payload_too_large" } })
  assert.deepEqual(json("fixtures/errors/415.json").body, { version: 1, error: { code: "unsupported_media_type" } })
}

function validateNegativeCorpus() {
  const negative = json("fixtures/negative.json")
  assert.equal(negative.length, 6)
  for (const fixture of negative) {
    assert.ok(typeof fixture.name === "string" && fixture.name.length > 0)
    assert.ok(typeof fixture.contentType === "string" && fixture.contentType.length > 0)
    if (fixture.expectedStatus !== undefined) {
      assert.equal(fixture.expectedStatus, fixture.name === "request-over-16-kib" ? 413 : fixture.name === "non-json-content-type" ? 415 : 400)
      assert.equal(fixture.expectedCode, fixture.name === "request-over-16-kib" ? "payload_too_large" : fixture.name === "non-json-content-type" ? "unsupported_media_type" : "invalid_request")
    } else {
      assert.equal(fixture.expectedProtocolError, "SidecarProtocolError")
    }
  }
  const mismatch = negative.find(({ name }) => name === "id-url-mismatch")
  assert.ok(mismatch)
  assert.notEqual(mismatch.body.track.id, new URL(mismatch.body.track.url).searchParams.get("v"))
  const schemaDrift = negative.find(({ name }) => name === "unknown-response-field")
  assert.ok(schemaDrift)
  assert.equal(schemaDrift.response.debug, true)
  const unsafe = negative.find(({ name }) => name === "unsafe-media-header")
  assert.ok(unsafe)
  assert.equal(unsafe.response.media.headers.Host, "127.0.0.1")
  assert.equal(readFileSync(path("raw/ytdlp-resolve-invalid-json.txt"), "utf8"), "{not-json\n")
}

function validateOrdinals(manifest) {
  const ordinal = manifest.raw.find(({ path: itemPath }) => itemPath === "raw/innertube-ordinal-malformed-valid.json")
  assert.ok(ordinal)
  const raw = json(ordinal.path)
  assert.equal(raw.contents.length, 6)
  assert.equal(raw.contents[0].videoRenderer.videoId, 7)
  assert.equal(raw.contents[1].videoRenderer.videoId, "valid-ordinal-1")
  assert.equal(raw.contents[5].videoRenderer.videoId, "outside-window-5")
  assert.deepEqual(ordinal.expected, { outcome: "response", fixture: "fixtures/responses/search-ordinal.json" })
  const results = json(ordinal.expected.fixture).results
  assert.equal(results.length, 1)
  assert.equal(results[0].track.id, "valid-ordinal-1")
  assert.equal(results[0].score, 0.9)
}

function validateFixtureSecrecy(manifest) {
  const fixturePaths = [
    ...manifest.raw.map(({ path: itemPath }) => itemPath),
    "fixtures/requests/search.json",
    "fixtures/requests/resolve.json",
    "fixtures/responses/search-ordinal.json",
    "fixtures/responses/resolve.json",
    "fixtures/negative.json",
  ]
  for (const fixturePath of fixturePaths) {
    assert.doesNotMatch(readFileSync(path(fixturePath), "utf8"), /authorization|cookie|token=|signature|secret/iu)
  }
}

function validateCauseTable() {
  const table = json("fixtures/cause-status-table.json")
  assert.equal(table.length, 17)
  for (const row of table) {
    exactKeys(row, ["cause", "rust", "node", "fallback", "state"])
    assert.ok(typeof row.cause === "string" && row.cause.length > 0)
    assert.ok(typeof row.rust === "string" && row.rust.length > 0)
    assert.ok(typeof row.node === "string" && row.node.length > 0)
    assert.ok(["no", "yes_once_rust", "local_authoritative", "unchanged"].includes(row.fallback))
    assert.ok(["ready", "degraded", "unchanged", "disabled", "unknown"].includes(row.state))
    assert.doesNotMatch(`${row.rust} ${row.node}`, /unspecified|tbd/iu)
  }
  assert.deepEqual(table.map(({ cause }) => cause), [
    "valid strict response", "invalid request or id/url mismatch", "body above 16 KiB", "non-JSON content type",
    "no extractor permit", "Innertube or yt-dlp valid failure", "Innertube redirect", "Rust deadline", "Node deadline",
    "sanitized Rust internal failure", "refused reset or DNS transport", "malformed version-skew unsafe or oversized response",
    "sidecar redirect response", "caller request abort", "shadow comparison mismatch", "shadow capacity 32 reached",
    "any later valid sidecar success",
  ])
  assert.deepEqual(
    table.filter(({ rust }) => rust.startsWith("4")).map(({ rust }) => rust),
    ["400/invalid_request", "413/payload_too_large", "415/unsupported_media_type", "429/busy"],
  )
}

function validateContractText() {
  const contract = readFileSync(path("contract.md"), "utf8")
  for (const [status, code] of errorCodes) assert.match(contract, new RegExp(`${status}.*${code}`, "u"))
  for (const sourceTest of parserTests) assert.match(contract, new RegExp(sourceTest.replace(/[()[\].?+*^$]/gu, "\\$&"), "u"))
  assert.match(contract, /valid ordinal 1.*0\.9/iu)
  assert.match(contract, /ordinal 5.*omitted/iu)
  for (const { cause, node } of json("fixtures/cause-status-table.json")) {
    assert.ok(contract.toLocaleLowerCase("en-US").includes(cause.toLocaleLowerCase("en-US")))
    assert.ok(contract.includes(node))
  }
}

const options = new Set(process.argv.slice(2))
for (const option of options) assert.ok(["--verify-manifest", "--verify-parser-migration", "--verify-ordinals", "--negative"].includes(option))
const manifest = json("manifest.json")
validateManifest(manifest)
validateProtocolFixtures()
validateNegativeCorpus()
validateOrdinals(manifest)
validateCauseTable()
validateFixtureSecrecy(manifest)
validateContractText()
console.log(`v1 contract verified: ${manifest.raw.length} raw fixtures, ${manifest.parserMigration.length} parser migrations`)
