import type { z } from "zod/mini"
import { SessionSchema } from "$lib/domain/schemas.js"

const key = "discord-music.session"
export type Session = Readonly<z.infer<typeof SessionSchema>>

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">
type LocationLike = { hash: string; readonly pathname: string; readonly search: string }
type HistoryLike = { replaceState(data: unknown, unused: string, url: string): unknown }

export function createSessionStore(storage: StorageLike, now: () => number = Date.now) {
  return {
    load(): Session | null {
      const raw = storage.getItem(key)
      if (raw === null) return null
      const parsed = SessionSchema.safeParse(JSON.parse(raw))
      if (!parsed.success || Date.parse(parsed.data.expiresAt) <= now()) {
        storage.removeItem(key)
        return null
      }
      return parsed.data
    },
    save(session: Session): void {
      storage.setItem(key, JSON.stringify(SessionSchema.parse(session)))
    },
    clear(): void {
      storage.removeItem(key)
    },
  }
}

export async function consumeAuthFragment(
  location: LocationLike,
  history: HistoryLike,
  exchange: (code: string) => Promise<Session>,
): Promise<
  | { readonly kind: "authenticated"; readonly session: Session }
  | { readonly kind: "none" }
  | { readonly kind: "error"; readonly code: string }
> {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""))
  const code = params.get("code")
  const error = params.get("error")
  location.hash = ""
  history.replaceState(null, "", `${location.pathname}${location.search}`)
  if (error !== null) return { kind: "error", code: error }
  if (code === null) return { kind: "none" }
  return { kind: "authenticated", session: SessionSchema.parse(await exchange(code)) }
}
