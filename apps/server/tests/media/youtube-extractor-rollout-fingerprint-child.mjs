import { createYouTubeExtractorRollout } from "../../dist/media/youtube-extractor-rollout.js"

const track = {
  id: "fingerprint-track",
  provider: "youtube",
  title: "Fingerprint track",
  artist: "Artist",
  url: "https://www.youtube.com/watch?v=fingerprint-track",
  durationMs: 60_000,
  artworkUrl: "https://img.youtube.com/fingerprint-track.jpg",
}
const search = [{ track, score: 1, bitrateKbps: null }]
const media = {
  kind: "remote",
  url: "https://rr1---fixture.googlevideo.com/videoplayback?id=fingerprint",
  headers: {},
  container: "webm",
  codec: "opus",
  bitrateKbps: 128,
  seekable: true,
}
const observations = []
const rollout = createYouTubeExtractorRollout({
  mode: "shadow",
  local: { resolve: async () => media },
  localSearch: { search: async () => search },
  observe: (event) => observations.push(event),
  createSidecar: () => ({
    resolve: async () => media,
    search: async () => search,
    close: async () => undefined,
  }),
})

await Promise.all([rollout.search("fingerprint"), rollout.search("fingerprint")])
await rollout.drain()
await rollout.close()
const fingerprints = observations.flatMap(({ fingerprint, stage }) =>
  stage === "shadow_match" && typeof fingerprint === "string" ? [fingerprint] : [],
)
if (fingerprints.length !== 2) throw new TypeError("Expected two rollout fingerprints")
process.stdout.write(JSON.stringify({ fingerprints }))
