import type {
  HistoryItem,
  LoopMode,
  MediaSourcePreference,
  PlayerState,
  QueueItemId,
  SearchResult,
  Track,
} from "@discord-music/contracts"
import ky, { HTTPError } from "ky"
import type { z } from "zod/mini"
import {
  ApiErrorSchema,
  ChannelsSchema,
  HistorySchema,
  PlayerStateSchema,
  PlaylistImportResultSchema,
  ResultsSchema,
  SessionSchema,
  YouTubePlaylistSchema,
} from "$lib/domain/schemas.js"

export type VoiceChannel = Readonly<z.infer<typeof ChannelsSchema>["channels"][number]>
export const playlistRequestTimeoutMs = 30_000

export class DashboardApiError extends Error {
  readonly name = "DashboardApiError"
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export function createApi(
  apiUrl: string,
  getToken: () => string | null,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
) {
  const client = ky.create({
    prefixUrl: apiUrl.replace(/\/$/, ""),
    fetch: fetcher,
    timeout: 10_000,
    retry: 0,
    hooks: {
      beforeRequest: [
        (request) => {
          const token = getToken()
          if (token !== null) request.headers.set("authorization", `Bearer ${token}`)
        },
      ],
    },
  })
  const json = async <T>(request: Promise<Response>, schema: z.ZodMiniType<T>): Promise<T> => {
    try {
      return schema.parse(await (await request).json())
    } catch (error) {
      if (!(error instanceof HTTPError)) throw error
      const body = ApiErrorSchema.safeParse(await error.response.json())
      throw new DashboardApiError(
        body.success ? body.data.error.code : "request_failed",
        body.success ? body.data.error.message : "The request failed",
        error.response.status,
      )
    }
  }
  const stateMutation = (path: string, body?: object) =>
    json(client.post(path, body === undefined ? {} : { json: body }), PlayerStateSchema)
  return {
    exchange: (code: string) =>
      json(client.post("auth/exchange", { json: { code } }), SessionSchema),
    logout: () => client.post("auth/logout"),
    state: () => json(client.get("api/state"), PlayerStateSchema),
    channels: () =>
      json(client.get("api/voice-channels"), ChannelsSchema).then((value) => value.channels),
    history: (): Promise<readonly HistoryItem[]> =>
      json(client.get("api/history"), HistorySchema).then((value) => value.items),
    search: (query: string): Promise<readonly SearchResult[]> =>
      json(client.post("api/search", { json: { q: query } }), ResultsSchema).then(
        (value) => value.results,
      ),
    previewPlaylist: (url: string) =>
      json(
        client.post("api/playlists/preview", {
          json: { url },
          timeout: playlistRequestTimeoutMs,
        }),
        YouTubePlaylistSchema,
      ),
    importPlaylist: (url: string, expectedVersion: number, channelId?: string) =>
      json(
        client.post("api/queue/playlist", {
          json:
            channelId === undefined
              ? { url, expectedVersion }
              : { url, channelId, expectedVersion },
          timeout: playlistRequestTimeoutMs,
        }),
        PlaylistImportResultSchema,
      ),
    command: stateMutation,
    add: (track: Track, expectedVersion: number, channelId?: string) =>
      stateMutation(
        "api/queue",
        channelId === undefined
          ? { track, expectedVersion }
          : { track, channelId, expectedVersion },
      ),
    remove: (id: QueueItemId, expectedVersion: number) =>
      json(
        client.delete(`api/queue/${encodeURIComponent(id)}`, { json: { expectedVersion } }),
        PlayerStateSchema,
      ),
    clear: (expectedVersion: number) =>
      json(client.delete("api/queue", { json: { expectedVersion } }), PlayerStateSchema),
    reorder: (id: QueueItemId, index: number, expectedVersion: number) =>
      json(
        client.patch("api/queue/order", { json: { id, index, expectedVersion } }),
        PlayerStateSchema,
      ),
    queueCommand: (id: QueueItemId, action: "next" | "play", expectedVersion: number) =>
      stateMutation(`api/queue/${encodeURIComponent(id)}/${action}`, { expectedVersion }),
    volume: (volume: number) => stateMutation("api/player/volume", { volume }),
    loop: (loopMode: LoopMode) => stateMutation("api/player/loop", { loopMode }),
    seek: (positionMs: number) => stateMutation("api/player/seek", { positionMs }),
    join: (channelId: string) => stateMutation("api/voice/join", { channelId }),
    leave: () => stateMutation("api/voice/leave"),
    sourcePreference: (preference: MediaSourcePreference) =>
      json(client.patch("api/providers/preference", { json: { preference } }), PlayerStateSchema),
    connectMockTidal: () => stateMutation("api/providers/mock-tidal/connect"),
    disconnectMockTidal: () => stateMutation("api/providers/mock-tidal/disconnect"),
  }
}

export type DashboardApi = ReturnType<typeof createApi>
export type { PlayerState }
