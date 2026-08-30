import pino from "pino"

import { parseConfig } from "./config.js"
import { loggerOptions } from "./logger.js"
import { runProduction } from "./runtime/production.js"

const { LOG_LEVEL: logLevel } = process.env
const logger = pino(loggerOptions(logLevel ?? "info"))

async function main(): Promise<void> {
  const config = parseConfig(process.env)
  const server = await runProduction(config)
  logger.info({ address: server.address }, "server.started")
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "server.start.failed")
  process.exitCode = 1
})
