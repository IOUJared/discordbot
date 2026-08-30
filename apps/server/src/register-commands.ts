import { REST, Routes } from "discord.js"
import pino from "pino"
import { z } from "zod"

import { COMMAND_DEFINITIONS } from "./discord/commands.js"
import { loggerOptions } from "./logger.js"

const registrationEnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
})

const { LOG_LEVEL: logLevel } = process.env
const logger = pino(loggerOptions(logLevel ?? "info"))

async function main(): Promise<void> {
  const env = registrationEnvSchema.parse(process.env)
  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN)
  await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), {
    body: COMMAND_DEFINITIONS,
  })
  logger.info({ count: COMMAND_DEFINITIONS.length }, "discord.commands.registered")
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "discord.commands.registration.failed")
  process.exitCode = 1
})
