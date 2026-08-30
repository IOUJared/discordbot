import type { FastifyInstance } from "fastify"

import { authorize, type SessionStore } from "../auth/session-auth.js"
import type { SnapshotHub } from "../runtime/snapshot-hub.js"
import { joinSchema } from "./schemas.js"
import type { PlayerApi } from "./types.js"

export function registerVoiceRoutes(
  app: FastifyInstance,
  deps: {
    readonly sessions: SessionStore
    readonly player: PlayerApi
    readonly snapshots: SnapshotHub
  },
): void {
  app.post("/api/voice/join", async (request) => {
    authorize(request, deps.sessions)
    await deps.player.join(joinSchema.parse(request.body).channelId)
    return deps.snapshots.changed()
  })
  app.post("/api/voice/leave", async (request) => {
    authorize(request, deps.sessions)
    await deps.player.leave()
    return deps.snapshots.changed()
  })
}
