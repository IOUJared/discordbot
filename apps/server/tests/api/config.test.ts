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
})
