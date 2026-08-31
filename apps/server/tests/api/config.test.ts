import { describe, expect, it } from "vitest"

import { parseConfig } from "../../src/config.js"

const valid = {
  DISCORD_TOKEN: "bot-secret",
  DISCORD_CLIENT_ID: "client",
  DISCORD_CLIENT_SECRET: "oauth-secret",
  DISCORD_GUILD_ID: "guild",
  DISCORD_OWNER_ID: "owner",
  AUTHORIZED_USERS: "user-a,user-b",
  FRONTEND_URL: "https://music.example.com",
  PUBLIC_URL: "https://api.example.com",
  DATABASE_PATH: ":memory:",
}

describe("server configuration", () => {
  it("Given a complete environment When parsed Then exact origins and authorized users are typed", () => {
    const config = parseConfig(valid)

    expect(config.frontendOrigin).toBe("https://music.example.com")
    expect(config.discordOwnerId).toBe("owner")
    expect(config.authorizedUserIds.size).toBe(3)
    expect(config.authorizedUserIds.has("owner")).toBe(true)
  })

  it("Given no additional users When parsed Then the dedicated owner remains authorized", () => {
    const config = parseConfig({ ...valid, AUTHORIZED_USERS: "" })

    expect([...config.authorizedUserIds]).toEqual(["owner"])
  })

  it("Given an invalid frontend URL When parsed Then configuration is rejected", () => {
    expect(() => parseConfig({ ...valid, FRONTEND_URL: "javascript:alert(1)" })).toThrow()
  })

  it("Given no voice idle timeout When parsed Then five minutes is used", () => {
    const config = parseConfig(valid)

    expect(config.voiceIdleTimeoutMs).toBe(300_000)
  })

  it("Given a custom voice idle timeout When parsed Then seconds are converted to milliseconds", () => {
    const config = parseConfig({ ...valid, VOICE_IDLE_TIMEOUT: "42" })

    expect(config.voiceIdleTimeoutMs).toBe(42_000)
  })

  it("Given a YouTube cookies path When parsed Then the secret path is available to media resolution", () => {
    // Given
    const input = { ...valid, YOUTUBE_COOKIES_PATH: "/run/secrets/youtube.cookies.txt" }

    // When
    const config = parseConfig(input)

    // Then
    expect(config.youtubeCookiesPath).toBe("/run/secrets/youtube.cookies.txt")
  })

  it.each(["0", "1.5", "86401", "not-a-number"])(
    "Given invalid voice idle timeout %s When parsed Then configuration is rejected",
    (voiceIdleTimeout) => {
      expect(() => parseConfig({ ...valid, VOICE_IDLE_TIMEOUT: voiceIdleTimeout })).toThrow()
    },
  )
})
