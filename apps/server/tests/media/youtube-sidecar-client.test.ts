import { readFile } from "node:fs/promises"

import { TrackSchema } from "@discord-music/contracts"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  SidecarExtractorError,
  YouTubeSidecarClient,
} from "../../src/media/youtube-sidecar-client.js"
import { fakeServer, json, opened } from "./youtube-sidecar-client.test-helpers.js"

const fixtures = new URL("../../../../spec/media-sidecar/v1/", import.meta.url)

describe("YouTubeSidecarClient protocol", () => {
  it("pairs the direct Agent with its Undici fetch implementation", async () => {
    const source = await readFile(
      new URL("../../src/media/youtube-sidecar-client.ts", import.meta.url),
      "utf8",
    )
    expect(source).toMatch(/import \{ Agent, fetch as undiciFetch \} from "undici"/u)
    expect(source).toMatch(/undiciFetch\(new URL\(path, this\.baseUrl\), requestOptions\)/u)
    expect(source).not.toMatch(/globalThis\.fetch|from "ky"/u)
  })

  it("round-trips every v1 manifest case", async () => {
    // Given: every manifest row and its normalized response/error fixture.
    const manifest = z
      .object({
        raw: z.array(z.object({ path: z.string(), expected: z.object({ outcome: z.string() }) })),
      })
      .parse(JSON.parse(await readFile(new URL("manifest.json", fixtures), "utf8")))
    const search = JSON.parse(
      await readFile(new URL("fixtures/responses/search-ordinal.json", fixtures), "utf8"),
    )
    const resolve = JSON.parse(
      await readFile(new URL("fixtures/responses/resolve.json", fixtures), "utf8"),
    )
    const requests: Array<{
      readonly path: string
      readonly correlation: string | undefined
      readonly body: string
    }> = []
    const server = await fakeServer((request, response) => {
      const rawCorrelation = request.headers["x-media-sidecar-correlation-id"]
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        body += chunk
      })
      request.on("end", () => {
        requests.push({
          path: request.url ?? "",
          correlation: Array.isArray(rawCorrelation) ? rawCorrelation[0] : rawCorrelation,
          body,
        })
        if (request.url === "/healthz") json(response, 200, { version: 1, status: "ok" })
        else if (request.url === "/v1/search") json(response, 200, search)
        else json(response, 200, resolve)
      })
    })
    opened.push(server.close)
    const client = new YouTubeSidecarClient({ baseUrl: server.url })
    opened.push(() => client.close())

    // When: each declared Node consumer drives its corresponding private endpoint.
    for (const row of manifest.raw) {
      if (row.path.startsWith("raw/innertube")) {
        await expect(client.search("Northern Lines")).resolves.toEqual(search.results)
      } else if (row.expected.outcome === "response") {
        await expect(client.resolve(TrackSchema.parse(search.results[0].track))).resolves.toEqual(
          resolve.media,
        )
      } else {
        // Raw extractor failures normalize to the locked 502 envelope before crossing this boundary.
        const errorServer = await fakeServer((_request, response) =>
          json(response, 502, { version: 1, error: { code: "extractor_failed" } }),
        )
        opened.push(errorServer.close)
        const errorClient = new YouTubeSidecarClient({ baseUrl: errorServer.url })
        opened.push(() => errorClient.close())
        await expect(
          errorClient.resolve(TrackSchema.parse(search.results[0].track)),
        ).rejects.toBeInstanceOf(SidecarExtractorError)
      }
    }
    await expect(client.health()).resolves.toEqual({ version: 1, status: "ok" })

    // Then: all rows were consumed once, using opaque private correlations.
    expect(requests).toHaveLength(4)
    expect(requests.every(({ correlation }) => /^[0-9a-f-]{36}$/u.test(correlation ?? ""))).toBe(
      true,
    )
    expect(new Set(requests.map(({ correlation }) => correlation)).size).toBe(4)
    expect(requests.map(({ path, body }) => [path, body === "" ? null : JSON.parse(body)])).toEqual(
      [
        ["/v1/search", { version: 1, query: "Northern Lines" }],
        ["/v1/search", { version: 1, query: "Northern Lines" }],
        [
          "/v1/resolve",
          {
            version: 1,
            track: {
              id: "valid-ordinal-1",
              url: "https://www.youtube.com/watch?v=valid-ordinal-1",
            },
          },
        ],
        ["/healthz", null],
      ],
    )
  })
})
