import type { FastifyInstance } from "fastify"

import { authorize, type SessionStore } from "../auth/session-auth.js"
import type { SnapshotHub } from "../runtime/snapshot-hub.js"
import { sourcePreferenceSchema } from "./schemas.js"
import type { PlayerApi } from "./types.js"

type ProviderRouteDeps = {
  readonly sessions: SessionStore
  readonly player: PlayerApi
  readonly snapshots: SnapshotHub
}

export function registerProviderRoutes(app: FastifyInstance, deps: ProviderRouteDeps): void {
  app.patch("/api/providers/preference", async (request) => {
    authorize(request, deps.sessions)
    const { preference } = sourcePreferenceSchema.parse(request.body)
    deps.player.setSourcePreference(preference)
    return deps.snapshots.changed()
  })
  app.post("/api/providers/mock-tidal/connect", async (request) => {
    authorize(request, deps.sessions)
    deps.player.connectMockTidal()
    return deps.snapshots.changed()
  })
  app.post("/api/providers/mock-tidal/disconnect", async (request) => {
    authorize(request, deps.sessions)
    deps.player.disconnectMockTidal()
    return deps.snapshots.changed()
  })
}
