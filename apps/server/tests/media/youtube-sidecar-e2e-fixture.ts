import { request as httpRequest } from "node:http"

import { GuildIdSchema, type SearchResult, UserIdSchema } from "@discord-music/contracts"
import Fastify, { type FastifyInstance } from "fastify"

import { registerStateRoutes } from "../../src/api/state-routes.js"
import type { SearchApi } from "../../src/api/types.js"
import type { SidecarRuntimeObservationSink } from "../../src/media/youtube-sidecar-observation.js"

export type Deferred<Value> = {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
}

export type HttpSearchResult =
  | { readonly kind: "response"; readonly statusCode: number; readonly body: unknown }
  | { readonly kind: "closed" }

export type PendingHttpSearch = {
  readonly completion: Promise<HttpSearchResult>
  readonly destroy: () => void
}

export function deferred<Value>(): Deferred<Value> {
  let resolve: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve
  })
  if (resolve === undefined) throw new TypeError("Deferred was not initialized")
  return { promise, resolve }
}

export async function startSearchApp(
  search: SearchApi,
  observe: SidecarRuntimeObservationSink,
): Promise<{ readonly app: FastifyInstance; readonly address: string }> {
  const app = Fastify({ logger: false })
  registerStateRoutes(app, {
    sessions: {
      issue: () => ({ value: "valid", expiresAt: new Date(28_801_000) }),
      authorize: (value) =>
        value === "valid"
          ? { userId: UserIdSchema.parse("user-a"), expiresAt: new Date(28_801_000) }
          : null,
      revoke: () => undefined,
    },
    snapshots: {
      snapshot: () => {
        throw new TypeError("Snapshot route is outside this fixture")
      },
    },
    search,
    guildId: GuildIdSchema.parse("guild"),
    history: { list: () => [] },
    voiceChannels: async () => [],
    observeMediaSidecar: observe,
  })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  return { app, address }
}

export function beginHttpSearch(address: string, query: string): PendingHttpSearch {
  const payload = JSON.stringify({ q: query })
  const request = httpRequest(new URL("/api/search", address), {
    method: "POST",
    headers: {
      authorization: "Bearer valid",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
  })
  const completion = new Promise<HttpSearchResult>((resolve) => {
    request.once("response", (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        resolve({
          kind: "response",
          statusCode: response.statusCode ?? 0,
          body: JSON.parse(text),
        })
      })
    })
    request.once("error", () => resolve({ kind: "closed" }))
  })
  request.end(payload)
  return {
    completion,
    destroy: () => request.destroy(),
  }
}

export function searchApi(
  search: (query: string, signal?: AbortSignal) => Promise<readonly SearchResult[]>,
): SearchApi {
  return {
    search,
    playlist: async () => {
      throw new TypeError("Playlist route is outside this fixture")
    },
  }
}
