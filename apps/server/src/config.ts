import { z } from "zod"

const httpUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === "http:" || protocol === "https:"
}, "must be an HTTP(S) URL")

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_OWNER_ID: z.string().min(1),
  AUTHORIZED_USERS: z.string().default(""),
  FRONTEND_URL: httpUrl,
  PUBLIC_URL: httpUrl,
  DATABASE_PATH: z.string().min(1),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DISCORD_API_URL: httpUrl.default("https://discord.com/api/v10"),
})

export type ServerConfig = {
  readonly discordToken: string
  readonly discordClientId: string
  readonly discordClientSecret: string
  readonly guildId: string
  readonly discordOwnerId: string
  readonly authorizedUserIds: ReadonlySet<string>
  readonly frontendUrl: string
  readonly frontendOrigin: string
  readonly publicUrl: string
  readonly databasePath: string
  readonly host: string
  readonly port: number
  readonly logLevel: string
  readonly discordApiUrl: string
}

export function parseConfig(input: Readonly<Record<string, string | undefined>>): ServerConfig {
  const parsed = envSchema.parse(input)
  const authorizedUserIds = new Set([
    parsed.DISCORD_OWNER_ID,
    ...parsed.AUTHORIZED_USERS.split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  ])
  const frontend = new URL(parsed.FRONTEND_URL)
  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordClientSecret: parsed.DISCORD_CLIENT_SECRET,
    guildId: parsed.DISCORD_GUILD_ID,
    discordOwnerId: parsed.DISCORD_OWNER_ID,
    authorizedUserIds,
    frontendUrl: parsed.FRONTEND_URL.replace(/\/$/, ""),
    frontendOrigin: frontend.origin,
    publicUrl: parsed.PUBLIC_URL.replace(/\/$/, ""),
    databasePath: parsed.DATABASE_PATH,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    discordApiUrl: parsed.DISCORD_API_URL.replace(/\/$/, ""),
  }
}
