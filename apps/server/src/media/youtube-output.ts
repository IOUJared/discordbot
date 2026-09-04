import { BitrateKbpsSchema } from "@discord-music/contracts"
import { z } from "zod"

import { RemoteMediaUrlSchema } from "./media-url-policy.js"
import type { RemotePlayableMedia } from "./types.js"

const safeHttpHeadersSchema = z
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

const resolvedOutputSchema = z.object({
  url: RemoteMediaUrlSchema,
  http_headers: safeHttpHeadersSchema.default({}),
  ext: z.string().min(1),
  acodec: z.string().min(1),
  abr: z.number().positive().nullable().optional(),
  protocol: z.enum(["http", "https"]),
})

export function parseResolvedOutput(output: string): RemotePlayableMedia {
  const parsed = resolvedOutputSchema.parse(JSON.parse(output))
  return {
    kind: "remote",
    url: parsed.url,
    headers: parsed.http_headers,
    container: parsed.ext,
    codec: parsed.acodec,
    bitrateKbps:
      parsed.abr === null || parsed.abr === undefined
        ? null
        : BitrateKbpsSchema.parse(Math.round(parsed.abr)),
    seekable: true,
  }
}
