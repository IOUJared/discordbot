import { once } from "node:events"
import { createServer } from "node:http"

import { afterEach, describe, expect, it } from "vitest"

import { KyDiscordOAuth } from "../../src/auth/discord-oauth.js"

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

describe("Discord OAuth wire adapter", () => {
  it("Given Discord OAuth endpoints When exchanging Then PKCE is sent and identity is parsed", async () => {
    let tokenBody = ""
    const server = createServer((request, response) => {
      if (request.url === "/oauth2/token") {
        request.setEncoding("utf8")
        request.on("data", (chunk) => {
          tokenBody += String(chunk)
        })
        request.on("end", () => {
          response.setHeader("content-type", "application/json")
          response.end(JSON.stringify({ access_token: "discord-access" }))
        })
        return
      }
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ id: "user-a", username: "User" }))
    })
    servers.push(server)
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (address === null || typeof address === "string") throw new TypeError("Expected TCP address")
    const oauth = adapter(`http://127.0.0.1:${address.port}`)

    const identity = await oauth.exchange("callback-code", "pkce-verifier")

    expect(identity.id).toBe("user-a")
    expect(new URLSearchParams(tokenBody).get("code_verifier")).toBe("pkce-verifier")
  })

  it("Given Discord returns a missing guild member When checked Then membership is false", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 404
      response.end()
    })
    servers.push(server)
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (address === null || typeof address === "string") throw new TypeError("Expected TCP address")
    const oauth = adapter(`http://127.0.0.1:${address.port}`)

    expect(await oauth.isGuildMember("user-a")).toBe(false)
  })
})

function adapter(apiUrl: string): KyDiscordOAuth {
  return new KyDiscordOAuth({
    apiUrl,
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://api.example.com/auth/callback",
    guildId: "guild",
    botToken: "bot",
  })
}
