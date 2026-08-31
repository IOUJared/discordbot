import type { FastifyInstance } from "fastify"

import { authorize, type SessionStore } from "../auth/session-auth.js"
import type { SnapshotHub } from "../runtime/snapshot-hub.js"
import { ApiError, StaleVersionError } from "./errors.js"
import {
  addSchema,
  expectedVersionSchema,
  idParamsSchema,
  orderSchema,
  playlistImportSchema,
} from "./schemas.js"
import type { PlayerApi, SearchApi } from "./types.js"

export function registerQueueRoutes(
  app: FastifyInstance,
  deps: {
    readonly sessions: SessionStore
    readonly player: PlayerApi
    readonly search: SearchApi
    readonly snapshots: SnapshotHub
  },
): void {
  app.post("/api/queue", async (request) => {
    const session = authorize(request, deps.sessions)
    const input = addSchema.parse(request.body)
    requireCurrentVersion(input.expectedVersion, deps.snapshots)
    if (!deps.player.voiceStatus().connected) {
      if (input.channelId === undefined) {
        throw new ApiError(400, "voice_channel_required", "Choose a voice channel")
      }
      await deps.player.join(input.channelId)
    }
    await deps.player.enqueue(input.track, session.userId)
    await deps.player.startIfIdle()
    return deps.snapshots.changed()
  })
  app.post("/api/queue/playlist", async (request) => {
    const session = authorize(request, deps.sessions)
    const input = playlistImportSchema.parse(request.body)
    requireCurrentVersion(input.expectedVersion, deps.snapshots)
    const playlist = await deps.search.playlist(input.url)
    if (!deps.player.voiceStatus().connected) {
      if (input.channelId === undefined) {
        throw new ApiError(400, "voice_channel_required", "Choose a voice channel")
      }
      await deps.player.join(input.channelId)
    }
    await deps.player.enqueueMany(playlist.tracks, session.userId)
    await deps.player.startIfIdle()
    return { state: deps.snapshots.changed(), importedCount: playlist.tracks.length }
  })
  app.delete("/api/queue/:id", async (request) => {
    authorize(request, deps.sessions)
    requireCurrentVersion(expectedVersionSchema.parse(request.body).expectedVersion, deps.snapshots)
    deps.player.remove(idParamsSchema.parse(request.params).id)
    return deps.snapshots.changed()
  })
  app.delete("/api/queue", async (request) => {
    authorize(request, deps.sessions)
    requireCurrentVersion(expectedVersionSchema.parse(request.body).expectedVersion, deps.snapshots)
    deps.player.clear()
    return deps.snapshots.changed()
  })
  app.patch("/api/queue/order", async (request) => {
    authorize(request, deps.sessions)
    const input = orderSchema.parse(request.body)
    requireCurrentVersion(input.expectedVersion, deps.snapshots)
    deps.player.move(input.id, input.index)
    return deps.snapshots.changed()
  })
  app.post("/api/queue/:id/next", async (request) => {
    authorize(request, deps.sessions)
    requireCurrentVersion(expectedVersionSchema.parse(request.body).expectedVersion, deps.snapshots)
    deps.player.playNext(idParamsSchema.parse(request.params).id)
    return deps.snapshots.changed()
  })
  app.post("/api/queue/:id/play", async (request) => {
    authorize(request, deps.sessions)
    requireCurrentVersion(expectedVersionSchema.parse(request.body).expectedVersion, deps.snapshots)
    await deps.player.playSelected(idParamsSchema.parse(request.params).id)
    return deps.snapshots.changed()
  })
}

function requireCurrentVersion(expectedVersion: number, snapshots: SnapshotHub): void {
  const snapshot = snapshots.snapshot()
  if (expectedVersion !== snapshot.version) throw new StaleVersionError(snapshot)
}
