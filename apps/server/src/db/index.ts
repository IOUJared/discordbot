import type Database from "better-sqlite3"

import type { Clock } from "../domain/clock.js"
import { ExchangeCodeRepository, SessionRepository } from "./auth-repositories.js"
import { openDatabase } from "./database.js"
import { HistoryRepository } from "./history-repository.js"
import type { Random } from "./random.js"
import { SettingsRepository } from "./settings-repository.js"

export type PersistenceOptions = {
  readonly path: string
  readonly clock: Clock
  readonly random: Random
}

export type CleanupResult = { readonly deleted: number }

export class Persistence {
  readonly settings: SettingsRepository
  readonly history: HistoryRepository
  readonly exchangeCodes: ExchangeCodeRepository
  readonly sessions: SessionRepository

  constructor(
    private readonly database: Database.Database,
    clock: Clock,
    random: Random,
  ) {
    this.settings = new SettingsRepository(database, clock)
    this.history = new HistoryRepository(database)
    this.exchangeCodes = new ExchangeCodeRepository(database, clock, random)
    this.sessions = new SessionRepository(database, clock, random)
    this.clock = clock
  }

  private readonly clock: Clock

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)()
  }

  cleanupExpired(limit: number): CleanupResult {
    const parsedLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 0
    if (parsedLimit === 0) return { deleted: 0 }
    return this.transaction(() => {
      const now = this.clock.now().getTime()
      const exchange = this.database
        .prepare(`
          DELETE FROM oauth_exchange_codes WHERE token_hash IN (
            SELECT token_hash FROM oauth_exchange_codes
            WHERE expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?
          )
        `)
        .run(now, parsedLimit).changes
      const remaining = parsedLimit - exchange
      const sessions = this.database
        .prepare(`
          DELETE FROM sessions WHERE token_hash IN (
            SELECT token_hash FROM sessions
            WHERE expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?
          )
        `)
        .run(now, remaining).changes
      return { deleted: exchange + sessions }
    })
  }

  close(): void {
    this.database.close()
  }
}

export function openPersistence(options: PersistenceOptions): Persistence {
  return new Persistence(openDatabase(options.path), options.clock, options.random)
}
