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
  VOICE_IDLE_TIMEOUT: z.coerce.number().int().min(1).max(86_400).default(300),
  YOUTUBE_COOKIES_PATH: z.string().min(1).optional(),
  MEDIA_SIDECAR_MODE: z.enum(["disabled", "shadow", "rust"]).default("disabled"),
  MEDIA_SIDECAR_URL: httpUrl.optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DISCORD_API_URL: httpUrl.default("https://discord.com/api/v10"),
})

export type MediaSidecarConfig =
  | { readonly mode: "disabled" }
  | { readonly mode: "shadow"; readonly url: string }
  | { readonly mode: "rust"; readonly url: string }

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
  readonly voiceIdleTimeoutMs: number
  readonly youtubeCookiesPath?: string
  readonly logLevel: string
  readonly discordApiUrl: string
}

export type ParsedServerConfig = ServerConfig & {
  readonly mediaSidecar: MediaSidecarConfig
}

function parseMediaSidecarConfig(
  mode: "disabled" | "shadow" | "rust",
  url: string | undefined,
): MediaSidecarConfig {
  switch (mode) {
    case "disabled":
      return { mode }
    case "shadow":
      return { mode, url: httpUrl.parse(url) }
    case "rust":
      return { mode, url: httpUrl.parse(url) }
  }
}

export function parseConfig(
  input: Readonly<Record<string, string | undefined>>,
): ParsedServerConfig {
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
    voiceIdleTimeoutMs: parsed.VOICE_IDLE_TIMEOUT * 1_000,
    ...(parsed.YOUTUBE_COOKIES_PATH === undefined
      ? {}
      : { youtubeCookiesPath: parsed.YOUTUBE_COOKIES_PATH }),
    mediaSidecar: parseMediaSidecarConfig(parsed.MEDIA_SIDECAR_MODE, parsed.MEDIA_SIDECAR_URL),
    logLevel: parsed.LOG_LEVEL,
    discordApiUrl: parsed.DISCORD_API_URL.replace(/\/$/, ""),
  }
}
