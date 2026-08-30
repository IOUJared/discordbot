import { get } from "node:http"
import { get as getSecure } from "node:https"
import type { Readable } from "node:stream"

import { type RemoteMediaPolicy, remoteMediaPolicy } from "../media/media-url-policy.js"
import type { RemotePlayableMedia } from "../media/types.js"

const directTimeoutMs = 20_000

export class DirectMediaError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "DirectMediaError"
  }
}

type DirectStreamOptions = {
  readonly signal?: AbortSignal
  readonly policy?: RemoteMediaPolicy
}

export async function openDirectStream(
  media: RemotePlayableMedia,
  options: DirectStreamOptions = {},
): Promise<Readable> {
  const target = await (options.policy ?? remoteMediaPolicy).authorize(media.url)
  return new Promise((resolve, reject) => {
    const url = new URL(target.url)
    const request = (url.protocol === "https:" ? getSecure : get)(
      url,
      {
        headers: media.headers,
        port: target.port,
        signal: options.signal,
        lookup: (_hostname, _options, callback) => {
          if (_options.all) {
            callback(null, [{ address: target.address, family: target.family }])
            return
          }
          callback(null, target.address, target.family)
        },
      },
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
