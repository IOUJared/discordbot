import type { GuildId, HistoryItem } from "@discord-music/contracts"
import type { FastifyInstance } from "fastify"
import { authorize, type SessionStore } from "../auth/session-auth.js"
import type { SnapshotHub } from "../runtime/snapshot-hub.js"
import { searchSchema } from "./schemas.js"
import type { SearchApi, VoiceChannel } from "./types.js"

export type StateRouteDeps = {
  readonly sessions: SessionStore
  readonly snapshots: SnapshotHub
  readonly search: SearchApi
  readonly guildId: GuildId
  readonly history: { list(guildId: GuildId): readonly HistoryItem[] }
  readonly voiceChannels: () => Promise<readonly VoiceChannel[]>
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
  app.post("/api/search", async (request) => {
    authorize(request, deps.sessions)
    const { q } = searchSchema.parse(request.body)
    return { results: await deps.search.search(q) }
  })
}
