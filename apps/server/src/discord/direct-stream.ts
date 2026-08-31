import { get } from "node:http"
import { get as getSecure } from "node:https"
import { PassThrough, type Readable } from "node:stream"

import { type RemoteMediaPolicy, remoteMediaPolicy } from "../media/media-url-policy.js"
import type { RemotePlayableMedia } from "../media/types.js"

const directTimeoutMs = 20_000
const playbackBufferBytes = 128 * 1024
const playbackHighWaterMarkBytes = 512 * 1024

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

export async function bufferDirectStream(
  source: Readable,
  minimumBytes = playbackBufferBytes,
): Promise<Readable> {
  const buffer = new PassThrough({ highWaterMark: playbackHighWaterMarkBytes })
  const forwardSourceError = (error: Error) => buffer.destroy(error)
  source.once("error", forwardSourceError)
  buffer.once("close", () => source.off("error", forwardSourceError))
  source.pipe(buffer)
  if (minimumBytes === 0) return buffer

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      buffer.off("readable", onReadable)
      source.off("end", onEnd)
      buffer.off("error", onError)
    }
    const finish = () => {
      cleanup()
      resolve(buffer)
    }
    const onReadable = () => {
      if (buffer.readableLength >= minimumBytes) finish()
    }
    const onEnd = () => finish()
    const onError = (error: Error) => {
      cleanup()
      source.destroy()
      buffer.destroy()
      reject(new DirectMediaError("Direct media buffering failed", error))
    }

    buffer.on("readable", onReadable)
    source.once("end", onEnd)
    buffer.once("error", onError)
    onReadable()
  })
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
        request.setTimeout(0)
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
