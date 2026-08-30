import { createHash } from "node:crypto"

import { type UserId, UserIdSchema } from "@discord-music/contracts"
import type Database from "better-sqlite3"
import { z } from "zod"

import type { Clock } from "../domain/clock.js"
import type { Random } from "./random.js"

const credentialRowSchema = z.object({
  user_id: UserIdSchema,
  expires_at_ms: z.number().int().nonnegative(),
})
const exchangeLifetimeMs = 60_000
const sessionLifetimeMs = 8 * 60 * 60 * 1_000

export type IssuedCredential = {
  readonly value: string
  readonly expiresAt: Date
}

export type ExchangeResult =
  | { readonly kind: "accepted"; readonly userId: UserId }
  | { readonly kind: "rejected" }

export type AuthorizedSession = {
  readonly userId: UserId
  readonly expiresAt: Date
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export class ExchangeCodeRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock,
    private readonly random: Random,
  ) {}

  issue(userId: UserId): IssuedCredential {
    const value = this.random.token()
    const expiresAt = new Date(this.clock.now().getTime() + exchangeLifetimeMs)
    this.database
      .prepare(
        "INSERT INTO oauth_exchange_codes (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)",
      )
      .run(hash(value), UserIdSchema.parse(userId), expiresAt.getTime())
    return { value, expiresAt }
  }

  consume(value: string): ExchangeResult {
    const consumeOnce = (): ExchangeResult => {
      const tokenHash = hash(value)
      const raw = this.database
        .prepare("SELECT user_id, expires_at_ms FROM oauth_exchange_codes WHERE token_hash = ?")
        .get(tokenHash)
      this.database.prepare("DELETE FROM oauth_exchange_codes WHERE token_hash = ?").run(tokenHash)
      if (raw === undefined) return { kind: "rejected" }
      const row = credentialRowSchema.parse(raw)
      if (row.expires_at_ms <= this.clock.now().getTime()) return { kind: "rejected" }
      return { kind: "accepted", userId: row.user_id }
    }
    return this.database.transaction(consumeOnce)()
  }
}

export class SessionRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock,
    private readonly random: Random,
  ) {}

  issue(userId: UserId): IssuedCredential {
    const value = this.random.token()
    const expiresAt = new Date(this.clock.now().getTime() + sessionLifetimeMs)
    this.database
      .prepare("INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)")
      .run(hash(value), UserIdSchema.parse(userId), expiresAt.getTime())
    return { value, expiresAt }
  }

  authorize(value: string): AuthorizedSession | null {
    const raw = this.database
      .prepare(`
        SELECT user_id, expires_at_ms FROM sessions
        WHERE token_hash = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
      `)
      .get(hash(value), this.clock.now().getTime())
    if (raw === undefined) return null
    const row = credentialRowSchema.parse(raw)
    return { userId: row.user_id, expiresAt: new Date(row.expires_at_ms) }
  }

  revoke(value: string): void {
    this.database
      .prepare(
        "UPDATE sessions SET revoked_at_ms = ? WHERE token_hash = ? AND revoked_at_ms IS NULL",
      )
      .run(this.clock.now().getTime(), hash(value))
  }
}
