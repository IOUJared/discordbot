import type { FastifyInstance } from "fastify"

import type { ServerConfig } from "../config.js"
import { createShutdown } from "./shutdown.js"

export type RuntimeResources = {
  readonly player: { leave(): Promise<void> }
  readonly discord: { destroy(): void }
  readonly database: { close(): void }
}

export async function startServer(
  app: FastifyInstance,
  config: ServerConfig,
  resources?: RuntimeResources,
): Promise<{ readonly address: string; readonly shutdown: () => Promise<void> }> {
  const managed =
    resources === undefined
      ? [{ close: () => app.close() }]
      : [
          { close: () => resources.player.leave() },
          { close: () => app.close() },
          { close: () => resources.database.close() },
          { close: () => resources.discord.destroy() },
        ]
  const shutdown = createShutdown(managed)
  const onSignal = (): void => {
    void shutdown()
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  app.addHook("onClose", async () => {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
  })
  const address = await app.listen({ host: config.host, port: config.port })
  return { address, shutdown }
}
