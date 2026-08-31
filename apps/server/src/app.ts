import type { GuildId, HistoryItem } from "@discord-music/contracts"
import cors from "@fastify/cors"
import rateLimit from "@fastify/rate-limit"
import websocket from "@fastify/websocket"
import Fastify, { type FastifyInstance } from "fastify"
import { z } from "zod"

import { ApiError, errorBody, StaleVersionError, staleVersionBody } from "./api/errors.js"
import { registerPlayerRoutes } from "./api/player-routes.js"
import { registerQueueRoutes } from "./api/queue-routes.js"
import { registerStateRoutes } from "./api/state-routes.js"
import type { PlayerApi, SearchApi, VoiceChannel } from "./api/types.js"
import { registerVoiceRoutes } from "./api/voice-routes.js"
import type { DiscordOAuth } from "./auth/discord-oauth.js"
import type { OAuthStateStore } from "./auth/oauth-state.js"
import { registerAuthRoutes } from "./auth/routes.js"
import type { ExchangeStore, SessionStore } from "./auth/session-auth.js"
import type { ServerConfig } from "./config.js"
import { loggerOptions } from "./logger.js"
import type { DependencyStatus } from "./runtime/dependencies.js"
import { SnapshotHub } from "./runtime/snapshot-hub.js"
import { registerWebSocket } from "./runtime/websocket.js"

const statusErrorSchema = z.object({ statusCode: z.number().int() })

export type AppDeps = {
  readonly config: ServerConfig
  readonly oauth: DiscordOAuth
  readonly oauthStates: OAuthStateStore
  readonly exchangeCodes: ExchangeStore
  readonly sessions: SessionStore
  readonly player: PlayerApi
  readonly search: SearchApi
  readonly guildId: GuildId
  readonly history: { list(guildId: GuildId): readonly HistoryItem[] }
  readonly voiceChannels: () => Promise<readonly VoiceChannel[]>
  readonly onVoiceChannelsChanged: (listener: () => void) => () => void
  readonly dependencies: DependencyStatus
  readonly discordReady: () => boolean
  readonly startedAtMs?: number
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions(deps.config.logLevel), disableRequestLogging: true })
  const snapshots = new SnapshotHub(deps.player)
  app.addHook("onClose", async () => snapshots.close())
  await app.register(cors, {
    origin: (origin, callback) => callback(null, origin === deps.config.frontendOrigin),
    methods: ["GET", "POST", "PATCH", "DELETE"],
  })
  await app.register(rateLimit, { max: 120, timeWindow: 60_000 })
  await app.register(websocket)

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof StaleVersionError) {
      void reply.code(error.statusCode).send(staleVersionBody(error.snapshot))
      return
    }
    if (error instanceof ApiError) {
      void reply.code(error.statusCode).send(errorBody(error.code, error.message))
      return
    }
    if (error instanceof z.ZodError) {
      void reply.code(400).send(errorBody("validation_error", "Invalid request"))
      return
    }
    if (error instanceof RangeError) {
      void reply.code(400).send(errorBody("invalid_operation", error.message))
      return
    }
    const statusError = statusErrorSchema.safeParse(error)
    if (statusError.success && statusError.data.statusCode === 429) {
      void reply.code(429).send(errorBody("rate_limited", "Too many requests"))
      return
    }
    request.log.error({ err: error }, "request.failed")
    void reply.code(500).send(errorBody("internal_error", "Internal server error"))
  })

  app.get("/health", async () => ({
    status: deps.dependencies.ffmpeg && deps.dependencies.ytDlp ? "ok" : "degraded",
    discord: deps.discordReady() ? "ready" : "disconnected",
    voice: deps.player.voiceStatus().connected ? "connected" : "disconnected",
    uptime: Math.max(0, Math.floor((Date.now() - (deps.startedAtMs ?? Date.now())) / 1_000)),
  }))
  registerAuthRoutes(app, deps)
  registerStateRoutes(app, { ...deps, snapshots })
  registerQueueRoutes(app, { ...deps, snapshots })
  registerPlayerRoutes(app, { ...deps, snapshots })
  registerVoiceRoutes(app, { ...deps, snapshots })
  registerWebSocket(app, {
    frontendOrigin: deps.config.frontendOrigin,
    sessions: deps.sessions,
    snapshots,
    voiceChannels: deps.voiceChannels,
    onVoiceChannelsChanged: deps.onVoiceChannelsChanged,
  })
  return app
}
