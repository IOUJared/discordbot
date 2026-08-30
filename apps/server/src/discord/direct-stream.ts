import { get } from "node:http"
import { get as getSecure } from "node:https"
import type { Readable } from "node:stream"

import type { PlayableMedia } from "../media/types.js"

const directTimeoutMs = 20_000

export class DirectMediaError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "DirectMediaError"
  }
}

export async function openDirectStream(
  media: PlayableMedia,
  signal?: AbortSignal,
): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const url = new URL(media.url)
    const request = (url.protocol === "https:" ? getSecure : get)(
      url,
      { headers: media.headers, signal },
      (response) => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          response.destroy()
          reject(new DirectMediaError(`Direct media returned HTTP ${status}`))
          return
        }
        resolve(response)
      },
    )
    request.setTimeout(directTimeoutMs, () => {
      request.destroy(new DirectMediaError("Direct media request timed out"))
    })
    request.on("error", (error) => {
      reject(new DirectMediaError("Direct media request failed", error))
    })
  })
}
