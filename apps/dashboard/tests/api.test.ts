import {
  PlayerStateSchema,
  QueueItemIdSchema,
  TrackSchema,
  YouTubePlaylistSchema,
} from "@discord-music/contracts"
import { describe, expect, it } from "vitest"

import { createApi } from "../src/lib/services/api.js"

const state = PlayerStateSchema.parse({
  version: 7,
  player: {
    guildId: "guild-1",
    queue: [],
    currentItem: null,
    seekable: false,
    positionMs: 0,
    volume: 72,
    isPaused: false,
    loopMode: "off",
  },
  voice: {
    guildId: "guild-1",
    connected: false,
    channelId: null,
    muted: false,
    deafened: false,
  },
  providers: { preference: "youtube_only", mockTidalConnected: false },
})
const track = TrackSchema.parse({
  id: "track-1",
  provider: "youtube",
  title: "Track",
  artist: "Artist",
  url: "https://www.youtube.com/watch?v=track-1",
  durationMs: 240_000,
})

function createRecorder() {
  const requests: Array<{
    readonly method: string
    readonly authorization: string | null
    readonly body: unknown
  }> = []
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push({
      method: request.method,
      authorization: request.headers.get("authorization"),
      body: request.body === null ? null : await request.json(),
    })
    const body = request.url.endsWith("/api/search")
      ? { results: [] }
      : request.url.endsWith("/api/playlists/preview")
        ? YouTubePlaylistSchema.parse({
            id: "PL-list",
            title: "Road trip",
            author: "Jared",
            tracks: [track],
          })
        : request.url.endsWith("/api/queue/playlist")
          ? { state, importedCount: 1 }
          : state
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  return { requests, api: createApi("https://music.example", () => "session", fetcher) }
}

describe("dashboard API wire contract", () => {
  it("Given a YouTube playlist URL When previewing and importing Then both requests preserve the URL and queue version", async () => {
    // Given
    const recorder = createRecorder()
    const url = "https://www.youtube.com/playlist?list=PL-list"

    // When
    await recorder.api.previewPlaylist(url)
    const imported = await recorder.api.importPlaylist(url, 7, "voice-1")

    // Then
    expect(recorder.requests.map(({ method, body }) => ({ method, body }))).toEqual([
      { method: "POST", body: { url } },
      { method: "POST", body: { url, expectedVersion: 7, channelId: "voice-1" } },
    ])
    expect(imported.importedCount).toBe(1)
  })

  it("Given a search query When searching Then POST sends the query as JSON with bearer auth", async () => {
    const recorder = createRecorder()
    await recorder.api.search("northern lines")
    const request = recorder.requests[0]
    expect({
      method: request?.method,
      authorization: request?.authorization,
      body: request?.body,
    }).toEqual({
      method: "POST",
      authorization: "Bearer session",
      body: { q: "northern lines" },
    })
  })

  it("Given a queue item When reordering Then PATCH sends its unique ID and expected version", async () => {
    const recorder = createRecorder()
    await recorder.api.reorder(QueueItemIdSchema.parse("queue-1"), 2, 7)
    const request = recorder.requests[0]
    expect({ method: request?.method, body: request?.body }).toEqual({
      method: "PATCH",
      body: { id: "queue-1", index: 2, expectedVersion: 7 },
    })
  })

  it("Given queue mutations When sent Then every mutation includes expectedVersion", async () => {
    const recorder = createRecorder()
    const id = QueueItemIdSchema.parse("queue-1")
    await recorder.api.add(track, 7)
    await recorder.api.remove(id, 7)
    await recorder.api.clear(7)
    await recorder.api.queueCommand(id, "next", 7)
    const bodies = recorder.requests.map((request) => request.body)
    expect(bodies).toEqual([
      { track, expectedVersion: 7 },
      { expectedVersion: 7 },
      { expectedVersion: 7 },
      { expectedVersion: 7 },
    ])
  })

  it("Given provider settings When changed Then the protected provider routes receive typed mutations", async () => {
    const recorder = createRecorder()
    await recorder.api.connectMockTidal()
    await recorder.api.sourcePreference("youtube_only")
    await recorder.api.disconnectMockTidal()
    expect(recorder.requests.map(({ method, body }) => ({ method, body }))).toEqual([
      { method: "POST", body: null },
      { method: "PATCH", body: { preference: "youtube_only" } },
      { method: "POST", body: null },
    ])
  })
})
