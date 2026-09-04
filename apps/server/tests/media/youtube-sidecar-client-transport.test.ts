import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici"
import { describe, expect, it } from "vitest"

import {
  SidecarClientDeadlineError,
  SidecarProtocolError,
  YouTubeSidecarClient,
} from "../../src/media/youtube-sidecar-client.js"
import type { SidecarClientObservation } from "../../src/media/youtube-sidecar-observation.js"
import {
  environment,
  fakeServer,
  json,
  opened,
  setEnvironment,
} from "./youtube-sidecar-client.test-helpers.js"

describe("YouTubeSidecarClient transport", () => {
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
