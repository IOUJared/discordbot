import { once } from "node:events"
import { createServer, IncomingMessage } from "node:http"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"

import {
  bufferDirectStream,
  DirectMediaError,
  openDirectStream,
} from "../../src/discord/direct-stream.js"
import { type RemoteMediaPolicy, RemoteMediaUrlSchema } from "../../src/media/media-url-policy.js"
import type { RemotePlayableMedia } from "../../src/media/types.js"

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
          })
        }),
    ),
  )
})

describe("direct media HTTP boundary", () => {
  it("holds playback until a read-ahead reserve is available", async () => {
    // Given
    const source = new PassThrough()
    let ready = false
    const pending = bufferDirectStream(source, 8).then((stream) => {
      ready = true
      return stream
    })

    // When
    source.write("1234")
    await new Promise((resolve) => setImmediate(resolve))
    const beforeReserve = ready
    source.write("5678")
    const stream = await pending
    const buffered = stream.read(8)

    // Then
    expect({ beforeReserve, ready, buffered: buffered?.toString() }).toEqual({
      beforeReserve: false,
      ready: true,
      buffered: "12345678",
    })
    source.end()
    stream.destroy()
  })

  it("Given an established media response When playback stops reading Then no connection timeout remains", async () => {
    // Given
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "audio/webm" })
      response.write("audio")
    })
    servers.push(server)
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (address === null || typeof address === "string") {
      throw new RangeError("Expected an IP test server address")
    }
    const url = RemoteMediaUrlSchema.parse("http://rr1.googlevideo.com/audio")
    const policy: RemoteMediaPolicy = {
      async authorize() {
        return {
          url,
          hostname: "rr1.googlevideo.com",
          address: "127.0.0.1",
          family: 4,
          port: address.port,
        }
      },
    }
    const media: RemotePlayableMedia = {
      kind: "remote",
      url,
      headers: {},
      container: "webm",
      codec: "opus",
      bitrateKbps: null,
      seekable: true,
    }

    // When
    const stream = await openDirectStream(media, { policy })

    // Then
    if (!(stream instanceof IncomingMessage)) throw new TypeError("Expected an HTTP response")
    const timeout = stream.socket.timeout
    stream.destroy()
    expect(timeout).toBe(0)
  })

  it("does not follow a redirect to a private destination", async () => {
    // Given: an allowed delivery request that redirects to loopback.
    let initialRequests = 0
    let privateRequests = 0
    const server = createServer((request, response) => {
      if (request.url === "/private") {
        privateRequests += 1
        response.end("private")
        return
      }
      initialRequests += 1
      response.writeHead(302, { location: "http://127.0.0.1/private" })
      response.end()
    })
    servers.push(server)
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (address === null || typeof address === "string") {
      throw new RangeError("Expected an IP test server address")
    }
    const url = RemoteMediaUrlSchema.parse("http://redirect.googlevideo.com/start")
    const policy: RemoteMediaPolicy = {
      async authorize() {
        return {
          url,
          hostname: "redirect.googlevideo.com",
          address: "127.0.0.1",
          family: 4,
          port: address.port,
        }
      },
    }
    const media: RemotePlayableMedia = {
      kind: "remote",
      url,
      headers: {},
      container: "webm",
      codec: "opus",
      bitrateKbps: null,
      seekable: true,
    }

    // When: the direct HTTP sink receives the redirect.
    const open = openDirectStream(media, { policy })

    // Then: the redirect is rejected without requesting its target.
    await expect(open).rejects.toBeInstanceOf(DirectMediaError)
    expect({ initialRequests, privateRequests }).toEqual({ initialRequests: 1, privateRequests: 0 })
  })
})
