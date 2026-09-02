import { once } from "node:events"
import { createServer, get, IncomingMessage } from "node:http"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"

import {
  bufferDirectStream,
  DirectMediaError,
  openDirectStream,
  openSeekableMediaProxy,
  playbackBufferBytes,
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
  it("uses a 32 KiB default startup reserve", () => {
    // Given
    const expectedBytes = 32 * 1024

    // When
    const configuredBytes = playbackBufferBytes

    // Then
    expect(configuredBytes).toBe(expectedBytes)
  })

  it("forwards byte-range requests through the authorized seek bridge", async () => {
    // Given
    let receivedRange: string | undefined
    const server = createServer((request, response) => {
      receivedRange = request.headers.range
      response.writeHead(206, {
        "accept-ranges": "bytes",
        "content-range": "bytes 4-7/8",
        "content-length": "4",
      })
      response.end("5678")
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
    const proxy = await openSeekableMediaProxy(
      {
        kind: "remote",
        url,
        headers: {},
        container: "webm",
        codec: "opus",
        bitrateKbps: null,
        seekable: true,
      },
      { policy },
    )

    // When
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = get(proxy.url, { headers: { range: "bytes=4-" } }, resolve)
      request.once("error", reject)
    })
    let body = ""
    response.setEncoding("utf8")
    response.on("data", (chunk: string) => {
      body += chunk
    })
    await once(response, "end")
    proxy.close()

    // Then
    expect({ status: response.statusCode, receivedRange, body }).toEqual({
      status: 206,
      receivedRange: "bytes=4-",
      body: "5678",
    })
  })

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
