import { randomUUID } from "node:crypto"

import type { GuildId, HistoryItem } from "@discord-music/contracts"
import type { FastifyInstance } from "fastify"
import { authorize, type SessionStore } from "../auth/session-auth.js"
import {
  MEDIA_SIDECAR_OBSERVATION_SCHEMA,
  registerRequestCorrelation,
  type SidecarRuntimeObservationSink,
} from "../media/youtube-sidecar-observation.js"
import type { SnapshotHub } from "../runtime/snapshot-hub.js"
import { playlistPreviewSchema, searchSchema } from "./schemas.js"
import type { SearchApi, VoiceChannel } from "./types.js"

export type StateRouteDeps = {
  readonly sessions: SessionStore
  readonly snapshots: Pick<SnapshotHub, "snapshot">
  readonly search: SearchApi
  readonly guildId: GuildId
  readonly history: { list(guildId: GuildId): readonly HistoryItem[] }
  readonly voiceChannels: () => Promise<readonly VoiceChannel[]>
  readonly observeMediaSidecar?: SidecarRuntimeObservationSink
}

export function registerStateRoutes(app: FastifyInstance, deps: StateRouteDeps): void {
  app.get("/api/state", async (request) => {
    authorize(request, deps.sessions)
    return deps.snapshots.snapshot()
  })
  app.get("/api/voice-channels", async (request) => {
    authorize(request, deps.sessions)
    return { channels: await deps.voiceChannels() }
  })
  app.get("/api/history", async (request) => {
    authorize(request, deps.sessions)
    return { items: deps.history.list(deps.guildId) }
  })
  app.post("/api/search", async (request, reply) => {
    authorize(request, deps.sessions)
    const { q } = searchSchema.parse(request.body)
    const correlationId = randomUUID()
    const controller = new AbortController()
    registerRequestCorrelation(controller.signal, correlationId)
    let active = true
    const observe = (stage: "route_start" | "response_finish" | "disconnect"): void => {
      deps.observeMediaSidecar?.({
        schema: MEDIA_SIDECAR_OBSERVATION_SCHEMA,
        stage,
        correlationId,
      })
    }
    const cleanup = (): void => {
      request.raw.removeListener("aborted", disconnect)
      reply.raw.removeListener("finish", finish)
      reply.raw.removeListener("close", disconnect)
      reply.raw.removeListener("error", disconnect)
      reply.raw.socket?.removeListener("close", disconnect)
    }
    const finish = (): void => {
      if (!active) return
      active = false
      cleanup()
      observe("response_finish")
    }
    const disconnect = (): void => {
      if (!active) return
      if (reply.raw.writableFinished) {
        active = false
        cleanup()
        return
      }
      active = false
      cleanup()
      observe("disconnect")
      controller.abort()
    }
    request.raw.once("aborted", disconnect)
    reply.raw.once("finish", finish)
    reply.raw.once("close", disconnect)
    reply.raw.once("error", disconnect)
    reply.raw.socket?.once("close", disconnect)
    observe("route_start")
    try {
      return { results: await deps.search.search(q, controller.signal) }
    } catch (error) {
      if (controller.signal.aborted) return reply
      throw error
    }
  })
  app.post("/api/playlists/preview", async (request) => {
    authorize(request, deps.sessions)
    const { url } = playlistPreviewSchema.parse(request.body)
    return deps.search.playlist(url)
  })
}
