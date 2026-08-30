import type { UserId } from "@discord-music/contracts"
import type { FastifyRequest } from "fastify"

import { ApiError } from "../api/errors.js"

export type Session = { readonly userId: UserId; readonly expiresAt: Date }
export interface SessionStore {
  issue(userId: UserId): { readonly value: string; readonly expiresAt: Date }
  authorize(value: string): Session | null
  revoke(value: string): void
}

export interface ExchangeStore {
  issue(userId: UserId): { readonly value: string; readonly expiresAt: Date }
  consume(
    value: string,
  ): { readonly kind: "accepted"; readonly userId: UserId } | { readonly kind: "rejected" }
}

export function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new ApiError(401, "unauthorized", "Authentication required")
  }
  const token = authorization.slice(7)
  if (token.length === 0) throw new ApiError(401, "unauthorized", "Authentication required")
  return token
}

export function authorize(request: FastifyRequest, sessions: SessionStore): Session {
  const session = sessions.authorize(bearerToken(request))
  if (session === null) throw new ApiError(401, "unauthorized", "Authentication required")
  return session
}
