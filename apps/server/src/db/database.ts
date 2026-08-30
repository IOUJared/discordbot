import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import Database from "better-sqlite3"

import { migrate } from "./migrations.js"

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 })
  }
  const database = new Database(path)
  database.pragma("journal_mode = WAL")
  database.pragma("foreign_keys = ON")
  database.pragma("busy_timeout = 5000")
  migrate(database)
  return database
}
