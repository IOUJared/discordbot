import { UserIdSchema } from "@discord-music/contracts"
import type { FastifyInstance } from "fastify"

import { exchangeSchema, oauthCallbackSchema } from "../api/schemas.js"
import type { ServerConfig } from "../config.js"
import type { DiscordOAuth } from "./discord-oauth.js"
import type { OAuthStateStore } from "./oauth-state.js"
import { authorize, bearerToken, type ExchangeStore, type SessionStore } from "./session-auth.js"

export type AuthRouteDeps = {
  readonly config: ServerConfig
  readonly oauth: DiscordOAuth
  readonly oauthStates: OAuthStateStore
  readonly exchangeCodes: ExchangeStore
  readonly sessions: SessionStore
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.get("/auth/discord", async (_request, reply) => {
    const issued = deps.oauthStates.issue()
    const query = new URLSearchParams({
      client_id: deps.config.discordClientId,
      redirect_uri: `${deps.config.publicUrl}/auth/discord/callback`,
      response_type: "code",
      scope: "identify",
      state: issued.state,
      code_challenge: issued.challenge,
      code_challenge_method: "S256",
    })
    return reply.redirect(`https://discord.com/oauth2/authorize?${query.toString()}`)
  })

  app.get("/auth/discord/callback", async (request, reply) => {
    const parsed = oauthCallbackSchema.safeParse(request.query)
    if (!parsed.success) return redirectError(reply, deps.config.frontendUrl, "invalid_callback")
    const state = deps.oauthStates.consume(parsed.data.state)
    if (state.kind === "rejected")
      return redirectError(reply, deps.config.frontendUrl, "invalid_state")
    try {
      const identity = await deps.oauth.exchange(parsed.data.code, state.verifier)
      if (!deps.config.authorizedUserIds.has(identity.id)) {
        return redirectError(reply, deps.config.frontendUrl, "not_authorized")
      }
      if (!(await deps.oauth.isGuildMember(identity.id))) {
        return redirectError(reply, deps.config.frontendUrl, "not_in_guild")
      }
      const issued = deps.exchangeCodes.issue(UserIdSchema.parse(identity.id))
      return reply.redirect(`${deps.config.frontendUrl}/#code=${encodeURIComponent(issued.value)}`)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      request.log.warn({ err: error }, "oauth.callback.failed")
      return redirectError(reply, deps.config.frontendUrl, "oauth_failed")
    }
  })

  app.post("/auth/exchange", async (request, reply) => {
    const input = exchangeSchema.parse(request.body)
    const exchanged = deps.exchangeCodes.consume(input.code)
    if (exchanged.kind === "rejected") {
      return reply.code(401).send({ error: { code: "invalid_code", message: "Invalid code" } })
    }
    const issued = deps.sessions.issue(exchanged.userId)
    return { token: issued.value, expiresAt: issued.expiresAt.toISOString() }
  })

  app.get("/auth/me", async (request) => {
    const session = authorize(request, deps.sessions)
    return { userId: session.userId, expiresAt: session.expiresAt.toISOString() }
  })

  app.post("/auth/logout", async (request, reply) => {
    authorize(request, deps.sessions)
    deps.sessions.revoke(bearerToken(request))
    return reply.code(204).send()
  })
}

function redirectError(
  reply: { redirect(url: string): unknown },
  frontendUrl: string,
  code: string,
): unknown {
  return reply.redirect(`${frontendUrl}/#error=${code}`)
}
