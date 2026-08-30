import type { FastifyInstance } from "fastify"

import { authorize, type SessionStore } from "../auth/session-auth.js"
import type { SnapshotHub } from "../runtime/snapshot-hub.js"
import { loopSchema, seekSchema, volumeSchema } from "./schemas.js"
import type { PlayerApi } from "./types.js"

type Deps = {
  readonly sessions: SessionStore
  readonly player: PlayerApi
  readonly snapshots: SnapshotHub
}

export function registerPlayerRoutes(app: FastifyInstance, deps: Deps): void {
  app.post("/api/player/pause", async (request) => mutate(request, deps, () => deps.player.pause()))
  app.post("/api/player/resume", async (request) =>
    mutate(request, deps, () => deps.player.resume()),
  )
  app.post("/api/player/skip", async (request) => mutate(request, deps, () => deps.player.skip()))
  app.post("/api/player/stop", async (request) => mutate(request, deps, () => deps.player.stop()))
  app.post("/api/player/restart", async (request) =>
    mutate(request, deps, () => deps.player.restart()),
  )
  app.post("/api/player/seek", async (request) => {
    return mutate(request, deps, () => {
      const { positionMs } = seekSchema.parse(request.body)
      return deps.player.seek(positionMs)
    })
  })
  app.post("/api/player/volume", async (request) => {
    return mutate(request, deps, () => {
      const { volume } = volumeSchema.parse(request.body)
      deps.player.setVolume(volume)
    })
  })
  app.post("/api/player/loop", async (request) => {
    return mutate(request, deps, () => {
      const { loopMode } = loopSchema.parse(request.body)
      deps.player.setLoop(loopMode)
    })
  })
  app.post("/api/player/shuffle", async (request) =>
    mutate(request, deps, () => deps.player.shuffle()),
  )
}

async function mutate(
  request: Parameters<typeof authorize>[0],
  deps: Deps,
  operation: () => unknown,
): Promise<ReturnType<SnapshotHub["snapshot"]>> {
  authorize(request, deps.sessions)
  await operation()
  return deps.snapshots.changed()
}
