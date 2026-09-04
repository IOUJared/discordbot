import type { ServerResponse } from "node:http"

import { describe, expect, it } from "vitest"

import {
  SidecarProtocolError,
  YouTubeSidecarClient,
} from "../../src/media/youtube-sidecar-client.js"
import { fakeServer, json, opened } from "./youtube-sidecar-client.test-helpers.js"

describe("YouTubeSidecarClient response body lifecycle", () => {
  it.each([
    ["non-JSON", 200, { "content-type": "text/plain" }],
    ["redirect", 302, { "content-type": "application/json", location: "/elsewhere" }],
  ] as const)(
    "releases every pool slot after streaming %s responses",
    async (_kind, status, headers) => {
      // Given: all eight dedicated pool slots receive protocol-invalid bodies that never end.
      let requests = 0
      const streaming = new Set<ServerResponse>()
      const server = await fakeServer((_request, response) => {
        requests += 1
        if (requests <= 8) {
          streaming.add(response)
          response.on("close", () => streaming.delete(response))
          response.writeHead(status, headers)
          response.write("invalid")
          return
        }
        json(response, 200, { version: 1, results: [] })
      })
      opened.push(server.close)
      const client = new YouTubeSidecarClient({ baseUrl: server.url, searchDeadlineMs: 250 })
      opened.push(() => client.close())

      try {
        // When: each malformed response is rejected before a ninth valid request is made.
        await Promise.all(
          Array.from({ length: 8 }, (_unused, index) =>
            expect(client.search(`invalid-${index}`)).rejects.toBeInstanceOf(SidecarProtocolError),
          ),
        )

        // Then: invalid streaming bodies cannot retain the pool and block valid work.
        await expect(client.search("valid")).resolves.toEqual([])
        expect(requests).toBe(9)
      } finally {
        for (const response of streaming) response.destroy()
      }
    },
  )

  it("releases malformed, oversized, and failed body reads before later requests", async () => {
    // Given: three body failures are each followed by a valid response on the same client.
    let requests = 0
    const streaming = new Set<ServerResponse>()
    const server = await fakeServer((_request, response) => {
      requests += 1
      if (requests === 1) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end("{")
      } else if (requests === 3) {
        streaming.add(response)
        response.on("close", () => streaming.delete(response))
        response.writeHead(200, { "content-type": "application/json" })
        response.write("x".repeat(1_048_577))
      } else if (requests === 5) {
        response.writeHead(200, { "content-type": "application/json" })
        response.write("{")
        response.destroy(new Error("read failed"))
      } else {
        json(response, 200, { version: 1, results: [] })
      }
    })
    opened.push(server.close)
    const client = new YouTubeSidecarClient({ baseUrl: server.url, searchDeadlineMs: 500 })
    opened.push(() => client.close())

    try {
      // When/Then: each body failure keeps its taxonomy and the following request still completes.
      await expect(client.search("malformed")).rejects.toBeInstanceOf(SidecarProtocolError)
      await expect(client.search("after-malformed")).resolves.toEqual([])
      await expect(client.search("oversized")).rejects.toBeInstanceOf(SidecarProtocolError)
      await expect(client.search("after-oversized")).resolves.toEqual([])
      await expect(client.search("read-error")).rejects.toMatchObject({
        name: "SidecarUnavailableError",
      })
      await expect(client.search("after-read-error")).resolves.toEqual([])
    } finally {
      for (const response of streaming) response.destroy()
    }
  })
})
