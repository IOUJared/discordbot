import type { SearchResult, Track } from "@discord-music/contracts"
import { Agent, fetch as undiciFetch } from "undici"

import type { PlayableMedia } from "./types.js"
import {
  MEDIA_SIDECAR_OBSERVATION_SCHEMA,
  makeSidecarResolveRequest,
  makeSidecarSearchRequest,
  parseSidecarHealth,
  parseSidecarHttpError,
  parseSidecarResolve,
  parseSidecarSearch,
  requestCorrelationId,
  SidecarClientDeadlineError,
  SidecarError,
  type SidecarObservationSink,
  type SidecarOperation,
  SidecarUnavailableError,
  sidecarFailureKind,
  sidecarProtocolError,
} from "./youtube-sidecar-observation.js"

export {
  SidecarClientDeadlineError,
  SidecarDeadlineError,
  SidecarExtractorError,
  SidecarInternalError,
  SidecarInvalidRequestError,
  SidecarOverloadedError,
  SidecarProtocolError,
  SidecarRequestRejectedError,
  SidecarUnavailableError,
} from "./youtube-sidecar-observation.js"

const RESPONSE_LIMIT_BYTES = 1_048_576
const SEARCH_DEADLINE_MS = 3_000
const RESOLVE_DEADLINE_MS = 21_000
const CORRELATION_HEADER = "x-media-sidecar-correlation-id"

export type YouTubeSidecarClientOptions = {
  readonly baseUrl: string
  readonly observe?: SidecarObservationSink
  readonly searchDeadlineMs?: number
  readonly resolveDeadlineMs?: number
}

function parseBaseUrl(value: string): URL {
  const url = new URL(value)
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new TypeError("Sidecar URL must be direct HTTP(S)")
  return url
}

async function readBoundedBody(
  response: Awaited<ReturnType<typeof undiciFetch>>,
): Promise<unknown> {
  if (response.body === null) throw sidecarProtocolError()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    size += result.value.byteLength
    if (size > RESPONSE_LIMIT_BYTES) {
      await reader.cancel()
      throw sidecarProtocolError()
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw sidecarProtocolError()
    throw error
  }
}

export class YouTubeSidecarClient {
  private readonly baseUrl: URL
  private readonly dispatcher = new Agent({
    connections: 8,
    pipelining: 1,
    connect: { timeout: 1_000 },
    headersTimeout: 22_000,
    bodyTimeout: 22_000,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000,
  })
  private readonly observe: SidecarObservationSink
  private readonly searchDeadlineMs: number
  private readonly resolveDeadlineMs: number

  constructor(options: YouTubeSidecarClientOptions) {
    this.baseUrl = parseBaseUrl(options.baseUrl)
    this.observe = options.observe ?? (() => undefined)
    this.searchDeadlineMs = options.searchDeadlineMs ?? SEARCH_DEADLINE_MS
    this.resolveDeadlineMs = options.resolveDeadlineMs ?? RESOLVE_DEADLINE_MS
  }

  async health(signal?: AbortSignal): Promise<{ readonly version: 1; readonly status: "ok" }> {
    return this.request(
      "health",
      "/healthz",
      "GET",
      undefined,
      SEARCH_DEADLINE_MS,
      parseSidecarHealth,
      signal,
    )
  }

  async search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]> {
    const body = makeSidecarSearchRequest(query)
    return this.request(
      "search",
      "/v1/search",
      "POST",
      body,
      this.searchDeadlineMs,
      parseSidecarSearch,
      signal,
    )
  }

  async resolve(track: Track, signal?: AbortSignal): Promise<PlayableMedia> {
    const body = makeSidecarResolveRequest(track)
    return this.request(
      "resolve",
      "/v1/resolve",
      "POST",
      body,
      this.resolveDeadlineMs,
      parseSidecarResolve,
      signal,
    )
  }

  close(): Promise<void> {
    return this.dispatcher.close()
  }

  private async request<Output>(
    operation: SidecarOperation,
    path: string,
    method: "GET" | "POST",
    body: unknown,
    deadlineMs: number,
    parse: (value: unknown) => Output,
    callerSignal?: AbortSignal,
  ): Promise<Output> {
    const correlationId = requestCorrelationId(callerSignal)
    const controller = new AbortController()
    let abortSource: "caller" | "deadline" | undefined
    const abortFromCaller = (): void => {
      if (abortSource === undefined) abortSource = "caller"
      controller.abort()
    }
    if (callerSignal?.aborted === true) abortFromCaller()
    else callerSignal?.addEventListener("abort", abortFromCaller, { once: true })
    const timeout = setTimeout(() => {
      if (abortSource === undefined) abortSource = "deadline"
      controller.abort()
    }, deadlineMs)
    this.observe({
      schema: MEDIA_SIDECAR_OBSERVATION_SCHEMA,
      stage: "client_sent",
      operation,
      correlationId,
    })
    try {
      const requestOptions = {
        method,
        redirect: "manual",
        signal: controller.signal,
        dispatcher: this.dispatcher,
        headers: {
          [CORRELATION_HEADER]: correlationId,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      } as const
      const response = await undiciFetch(new URL(path, this.baseUrl), requestOptions)
      if (response.status >= 300 && response.status < 400) throw sidecarProtocolError()
      if (response.headers.get("content-type") !== "application/json") throw sidecarProtocolError()
      const parsedBody = await readBoundedBody(response)
      if (!response.ok) throw parseSidecarHttpError(response.status, parsedBody)
      const parsed = parse(parsedBody)
      this.observe({
        schema: MEDIA_SIDECAR_OBSERVATION_SCHEMA,
        stage: "client_success",
        operation,
        correlationId,
      })
      return parsed
    } catch (error) {
      let mapped: unknown = error
      if (abortSource === "caller")
        mapped = new DOMException("The operation was aborted", "AbortError")
      else if (abortSource === "deadline")
        mapped = new SidecarClientDeadlineError("Sidecar client deadline expired")
      else if (!(error instanceof SidecarError))
        mapped = new SidecarUnavailableError("Sidecar transport unavailable")
      this.observe({
        schema: MEDIA_SIDECAR_OBSERVATION_SCHEMA,
        stage: "client_failure",
        operation,
        correlationId,
        outcome: sidecarFailureKind(mapped),
      })
      throw mapped
    } finally {
      clearTimeout(timeout)
      callerSignal?.removeEventListener("abort", abortFromCaller)
    }
  }
}
