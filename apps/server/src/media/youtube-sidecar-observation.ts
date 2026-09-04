import {
  BitrateKbpsSchema,
  type SearchResult,
  SearchResultSchema,
  type Track,
  TrackSchema,
} from "@discord-music/contracts"
import { z } from "zod"

import { RemoteMediaUrlSchema } from "./media-url-policy.js"
import type { RemotePlayableMedia } from "./types.js"

export const MEDIA_SIDECAR_OBSERVATION_SCHEMA = "media_sidecar_observation.v1" as const
export type SidecarOperation = "health" | "search" | "resolve"
export type SidecarFailureKind =
  | "invalid_request"
  | "request_rejected"
  | "overloaded"
  | "extractor"
  | "deadline"
  | "client_deadline"
  | "internal"
  | "unavailable"
  | "protocol"
  | "caller_abort"
export type SidecarClientObservation = {
  readonly schema: typeof MEDIA_SIDECAR_OBSERVATION_SCHEMA
  readonly stage: "client_sent" | "client_success" | "client_failure"
  readonly operation: SidecarOperation
  readonly correlationId: string
  readonly outcome?: SidecarFailureKind
}
export type SidecarObservationSink = (event: SidecarClientObservation) => void

export class SidecarError extends Error {}
export class SidecarInvalidRequestError extends SidecarError {
  readonly name = "SidecarInvalidRequestError"
}
export class SidecarRequestRejectedError extends SidecarError {
  readonly name = "SidecarRequestRejectedError"
}
export class SidecarOverloadedError extends SidecarError {
  readonly name = "SidecarOverloadedError"
}
export class SidecarExtractorError extends SidecarError {
  readonly name = "SidecarExtractorError"
}
export class SidecarDeadlineError extends SidecarError {
  readonly name = "SidecarDeadlineError"
}
export class SidecarClientDeadlineError extends SidecarError {
  readonly name = "SidecarClientDeadlineError"
}
export class SidecarInternalError extends SidecarError {
  readonly name = "SidecarInternalError"
}
export class SidecarUnavailableError extends SidecarError {
  readonly name = "SidecarUnavailableError"
}
export class SidecarProtocolError extends SidecarError {
  readonly name = "SidecarProtocolError"
}

const youtubeId = /^[A-Za-z0-9_-]{1,128}$/u
const sidecarTrackSchema = TrackSchema.extend({ artworkUrl: z.url() }).refine(
  (track) =>
    youtubeId.test(track.id) && track.url === `https://www.youtube.com/watch?v=${track.id}`,
)
const searchResponseSchema = z
  .object({
    version: z.literal(1),
    results: z
      .array(SearchResultSchema.extend({ track: sidecarTrackSchema }))
      .max(5)
      .readonly(),
  })
  .strict()
const safeHeadersSchema = z
  .record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u), z.string().regex(/^[^\r\n]*$/u))
  .refine((headers) =>
    Object.keys(headers).every(
      (name) =>
        ![
          "host",
          "connection",
          "content-length",
          "proxy-authorization",
          "transfer-encoding",
        ].includes(name.toLocaleLowerCase()),
    ),
  )
const resolveResponseSchema = z
  .object({
    version: z.literal(1),
    media: z
      .object({
        kind: z.literal("remote"),
        url: RemoteMediaUrlSchema,
        headers: safeHeadersSchema,
        container: z.string().min(1),
        codec: z.string().min(1),
        bitrateKbps: BitrateKbpsSchema.nullable(),
        seekable: z.literal(true),
      })
      .strict(),
  })
  .strict()
const healthResponseSchema = z.object({ version: z.literal(1), status: z.literal("ok") }).strict()
const errorResponseSchema = z
  .object({
    version: z.literal(1),
    error: z
      .object({
        code: z.enum([
          "invalid_request",
          "payload_too_large",
          "unsupported_media_type",
          "busy",
          "internal",
          "extractor_failed",
          "deadline_exceeded",
        ]),
      })
      .strict(),
  })
  .strict()
const searchRequestSchema = z
  .object({ version: z.literal(1), query: z.string().min(1).max(512) })
  .strict()
const resolveRequestSchema = z
  .object({
    version: z.literal(1),
    track: z
      .object({
        id: z.string().regex(youtubeId),
        url: z.url().regex(/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{1,128}$/u),
      })
      .strict()
      .refine((track) => track.url === `https://www.youtube.com/watch?v=${track.id}`),
  })
  .strict()

export function sidecarProtocolError(): SidecarProtocolError {
  return new SidecarProtocolError("Sidecar response violated protocol")
}
export function parseSidecarHealth(value: unknown): { readonly version: 1; readonly status: "ok" } {
  const parsed = healthResponseSchema.safeParse(value)
  if (!parsed.success) throw sidecarProtocolError()
  return parsed.data
}
export function parseSidecarSearch(value: unknown): readonly SearchResult[] {
  const parsed = searchResponseSchema.safeParse(value)
  if (!parsed.success) throw sidecarProtocolError()
  return parsed.data.results
}
export function parseSidecarResolve(value: unknown): RemotePlayableMedia {
  const parsed = resolveResponseSchema.safeParse(value)
  if (!parsed.success) throw sidecarProtocolError()
  return parsed.data.media
}
export function makeSidecarSearchRequest(query: string): unknown {
  return searchRequestSchema.parse({ version: 1, query })
}
export function makeSidecarResolveRequest(track: Track): unknown {
  const parsedTrack = sidecarTrackSchema.parse(track)
  return resolveRequestSchema.parse({
    version: 1,
    track: { id: parsedTrack.id, url: parsedTrack.url },
  })
}
export function parseSidecarHttpError(status: number, value: unknown): SidecarError {
  const parsed = errorResponseSchema.safeParse(value)
  if (!parsed.success) return sidecarProtocolError()
  switch (`${status}:${parsed.data.error.code}`) {
    case "400:invalid_request":
      return new SidecarInvalidRequestError("Sidecar rejected request")
    case "413:payload_too_large":
    case "415:unsupported_media_type":
      return new SidecarRequestRejectedError("Sidecar rejected request")
    case "429:busy":
      return new SidecarOverloadedError("Sidecar is busy")
    case "500:internal":
      return new SidecarInternalError("Sidecar failed internally")
    case "502:extractor_failed":
      return new SidecarExtractorError("Sidecar extractor failed")
    case "504:deadline_exceeded":
      return new SidecarDeadlineError("Sidecar deadline expired")
    default:
      return sidecarProtocolError()
  }
}
export function sidecarFailureKind(error: unknown): SidecarFailureKind {
  if (error instanceof SidecarInvalidRequestError) return "invalid_request"
  if (error instanceof SidecarRequestRejectedError) return "request_rejected"
  if (error instanceof SidecarOverloadedError) return "overloaded"
  if (error instanceof SidecarExtractorError) return "extractor"
  if (error instanceof SidecarDeadlineError) return "deadline"
  if (error instanceof SidecarClientDeadlineError) return "client_deadline"
  if (error instanceof SidecarInternalError) return "internal"
  if (error instanceof SidecarUnavailableError) return "unavailable"
  if (error instanceof SidecarProtocolError) return "protocol"
  return "caller_abort"
}
