import { readFile } from "node:fs/promises"

import { TrackSchema } from "@discord-music/contracts"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  SidecarDeadlineError,
  SidecarExtractorError,
  SidecarInternalError,
  SidecarInvalidRequestError,
  SidecarOverloadedError,
  SidecarProtocolError,
  SidecarRequestRejectedError,
  SidecarUnavailableError,
  YouTubeSidecarClient,
} from "../../src/media/youtube-sidecar-client.js"
import { fakeServer, json, opened } from "./youtube-sidecar-client.test-helpers.js"

const fixtures = new URL("../../../../spec/media-sidecar/v1/", import.meta.url)

describe("YouTubeSidecarClient error taxonomy", () => {
  it("maps the complete error taxonomy without leaking payloads", async () => {
    // Given: every trusted Rust error plus malformed, unsafe, and oversized responses.
    const cases = [
      ["400.json", SidecarInvalidRequestError],
      ["413.json", SidecarRequestRejectedError],
      ["415.json", SidecarRequestRejectedError],
      ["429.json", SidecarOverloadedError],
      ["500.json", SidecarInternalError],
      ["502.json", SidecarExtractorError],
      ["504.json", SidecarDeadlineError],
    ] as const
    for (const [file, ErrorType] of cases) {
      const fixture = z
        .object({ status: z.number().int(), body: z.unknown() })
        .parse(JSON.parse(await readFile(new URL(`fixtures/errors/${file}`, fixtures), "utf8")))
      const server = await fakeServer((_request, response) =>
        json(response, fixture.status, fixture.body),
      )
      opened.push(server.close)
      const client = new YouTubeSidecarClient({ baseUrl: server.url })
      opened.push(() => client.close())
      await expect(client.search("secret-query")).rejects.toBeInstanceOf(ErrorType)
      await expect(client.search("secret-query")).rejects.not.toThrow(
        /secret-query|payload_too_large|extractor_failed/u,
      )
    }
    const negative = z
      .array(z.object({ name: z.string(), response: z.unknown().optional() }).passthrough())
      .parse(JSON.parse(await readFile(new URL("fixtures/negative.json", fixtures), "utf8")))
    const unknownField = negative.find(({ name }) => name === "unknown-response-field")?.response
    const unsafeMedia = negative.find(({ name }) => name === "unsafe-media-header")?.response
    const invalidSearchResponses = [
      { body: unknownField },
      {
        body: {
          version: 1,
          results: [
            {
              track: {
                id: "one",
                provider: "youtube",
                title: "x",
                artist: "y",
                url: "https://www.youtube.com/watch?v=two",
                durationMs: 1,
              },
              score: 1,
              bitrateKbps: null,
            },
          ],
        },
      },
      { body: "x".repeat(1_048_577) },
    ]
    for (const invalid of invalidSearchResponses) {
      const server = await fakeServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(typeof invalid.body === "string" ? invalid.body : JSON.stringify(invalid.body))
      })
      opened.push(server.close)
      const client = new YouTubeSidecarClient({ baseUrl: server.url })
      opened.push(() => client.close())
      await expect(client.search("secret-query")).rejects.toBeInstanceOf(SidecarProtocolError)
    }
    const unsafeServer = await fakeServer((_request, response) => json(response, 200, unsafeMedia))
    opened.push(unsafeServer.close)
    const unsafeClient = new YouTubeSidecarClient({ baseUrl: unsafeServer.url })
    opened.push(() => unsafeClient.close())
    const searchFixture = z
      .object({ results: z.array(z.object({ track: TrackSchema }).passthrough()).min(1) })
      .passthrough()
      .parse(
        JSON.parse(
          await readFile(new URL("fixtures/responses/search-ordinal.json", fixtures), "utf8"),
        ),
      )
    const validTrack = TrackSchema.parse(searchFixture.results[0]?.track)
    await expect(unsafeClient.resolve(validTrack)).rejects.toBeInstanceOf(SidecarProtocolError)

    const unavailable = await fakeServer((_request, response) =>
      json(response, 200, { version: 1, results: [] }),
    )
    await unavailable.close()
    const unavailableClient = new YouTubeSidecarClient({ baseUrl: unavailable.url })
    opened.push(() => unavailableClient.close())
    await expect(unavailableClient.search("transport")).rejects.toBeInstanceOf(
      SidecarUnavailableError,
    )
  })
})
