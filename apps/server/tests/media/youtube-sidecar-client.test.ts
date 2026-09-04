import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { TrackSchema } from "@discord-music/contracts"
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import {
  SidecarClientDeadlineError,
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
import type { SidecarClientObservation } from "../../src/media/youtube-sidecar-observation.js"

type Handler = (request: IncomingMessage, response: ServerResponse) => void

async function fakeServer(handler: Handler): Promise<{
  readonly url: string
  readonly close: () => Promise<void>
}> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("Expected TCP address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

function environment(name: "HTTP_PROXY" | "HTTPS_PROXY"): string | undefined {
  return process.env[name]
}

function setEnvironment(name: "HTTP_PROXY" | "HTTPS_PROXY", value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const fixtures = new URL("../../../../spec/media-sidecar/v1/", import.meta.url)
const opened: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((close) => close()))
})

describe("YouTubeSidecarClient", () => {
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
    expect(requests).toHaveLength(3)
    expect(requests.every(({ correlation }) => /^[0-9a-f-]{36}$/u.test(correlation ?? ""))).toBe(
      true,
    )
    expect(new Set(requests.map(({ correlation }) => correlation)).size).toBe(3)
    expect(requests.map(({ path, body }) => [path, body === "" ? null : JSON.parse(body)])).toEqual(
      [
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

  it("keeps deadline active through streamed body and distinguishes caller abort", async () => {
    // Given: one server delays headers and another stalls a syntactically valid body.
    const slow = await fakeServer((_request, response) =>
      setTimeout(() => json(response, 200, { version: 1, results: [] }), 100),
    )
    opened.push(slow.close)
    const stalled = await fakeServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.write('{"version":1,"results":[')
    })
    opened.push(stalled.close)

    // When/Then: both deadline phases map to the client deadline type.
    const slowClient = new YouTubeSidecarClient({ baseUrl: slow.url, searchDeadlineMs: 20 })
    opened.push(() => slowClient.close())
    await expect(slowClient.search("slow")).rejects.toBeInstanceOf(SidecarClientDeadlineError)
    const stalledClient = new YouTubeSidecarClient({ baseUrl: stalled.url, searchDeadlineMs: 20 })
    opened.push(() => stalledClient.close())
    await expect(stalledClient.search("stalled")).rejects.toBeInstanceOf(SidecarClientDeadlineError)

    // Given/When: the caller cancels independently before the client deadline.
    const controller = new AbortController()
    const observations: SidecarClientObservation[] = []
    const callerClient = new YouTubeSidecarClient({
      baseUrl: stalled.url,
      searchDeadlineMs: 500,
      observe: (event) => observations.push(event),
    })
    opened.push(() => callerClient.close())
    const outcome = callerClient.search("caller-secret", controller.signal)
    controller.abort()

    // Then: cancellation remains a native AbortError and observations contain no payload.
    await expect(outcome).rejects.toMatchObject({ name: "AbortError" })
    expect(JSON.stringify(observations)).not.toMatch(/caller-secret/u)
    expect(observations.map(({ stage }) => stage)).toEqual(["client_sent", "client_failure"])
    expect(observations.at(-1)?.outcome).toBe("caller_abort")
  })

  it("uses direct transport and rejects redirects without following", async () => {
    // Given: poisoned proxy variables, a disabled global dispatcher, and a redirect target.
    const priorHttpProxy = environment("HTTP_PROXY")
    const priorHttpsProxy = environment("HTTPS_PROXY")
    let proxyCalls = 0
    const proxy = await fakeServer((_request, response) => {
      proxyCalls += 1
      response.writeHead(502)
      response.end()
    })
    opened.push(proxy.close)
    setEnvironment("HTTP_PROXY", proxy.url)
    setEnvironment("HTTPS_PROXY", proxy.url)
    const priorDispatcher = getGlobalDispatcher()
    const blockedGlobal = new MockAgent()
    blockedGlobal.disableNetConnect()
    setGlobalDispatcher(blockedGlobal)
    let targetCalls = 0
    const target = await fakeServer((_request, response) => {
      targetCalls += 1
      json(response, 200, { version: 1, results: [] })
    })
    opened.push(target.close)
    let intendedCalls = 0
    const intended = await fakeServer((request, response) => {
      intendedCalls += 1
      if (request.url === "/v1/search") json(response, 200, { version: 1, results: [] })
      else response.end()
    })
    opened.push(intended.close)

    try {
      // When: the direct sidecar request runs.
      const direct = new YouTubeSidecarClient({ baseUrl: intended.url })
      opened.push(() => direct.close())
      await expect(direct.search("direct")).resolves.toEqual([])
      const redirect = await fakeServer((_request, response) => {
        response.writeHead(302, { location: `${target.url}/v1/search` })
        response.end()
      })
      opened.push(redirect.close)
      const redirectClient = new YouTubeSidecarClient({ baseUrl: redirect.url })
      opened.push(() => redirectClient.close())
      await expect(redirectClient.search("redirect")).rejects.toBeInstanceOf(SidecarProtocolError)

      // Then: the intended server is contacted directly and no redirect is followed.
      expect(intendedCalls).toBe(1)
      expect(proxyCalls).toBe(0)
      expect(targetCalls).toBe(0)
    } finally {
      setGlobalDispatcher(priorDispatcher)
      await blockedGlobal.close()
      setEnvironment("HTTP_PROXY", priorHttpProxy)
      setEnvironment("HTTPS_PROXY", priorHttpsProxy)
    }
  })
})
