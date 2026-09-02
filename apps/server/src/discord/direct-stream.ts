import { once } from "node:events"
import { createServer, get, type IncomingMessage } from "node:http"
import { get as getSecure } from "node:https"
import { PassThrough, type Readable } from "node:stream"

import { type RemoteMediaPolicy, remoteMediaPolicy } from "../media/media-url-policy.js"
import type { RemotePlayableMedia } from "../media/types.js"

const directTimeoutMs = 20_000
export const playbackBufferBytes = 32 * 1024
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
): Promise<IncomingMessage> {
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

export type SeekableMediaProxy = {
  readonly url: string
  readonly close: () => void
}

export async function openSeekableMediaProxy(
  media: RemotePlayableMedia,
  options: DirectStreamOptions = {},
): Promise<SeekableMediaProxy> {
  const upstreams = new Set<IncomingMessage>()
  const server = createServer(async (request, response) => {
    if (request.url !== "/media" || request.method !== "GET") {
      response.writeHead(404).end()
      return
    }
    try {
      const range = request.headers.range
      const upstream = await openDirectStream(
        {
          ...media,
          headers: range === undefined ? media.headers : { ...media.headers, range },
        },
        options,
      )
      upstreams.add(upstream)
      upstream.once("close", () => upstreams.delete(upstream))
      const headers = {
        ...(upstream.headers["accept-ranges"] === undefined
          ? {}
          : { "accept-ranges": upstream.headers["accept-ranges"] }),
        ...(upstream.headers["content-length"] === undefined
          ? {}
          : { "content-length": upstream.headers["content-length"] }),
        ...(upstream.headers["content-range"] === undefined
          ? {}
          : { "content-range": upstream.headers["content-range"] }),
        ...(upstream.headers["content-type"] === undefined
          ? {}
          : { "content-type": upstream.headers["content-type"] }),
      }
      response.writeHead(upstream.statusCode ?? 200, headers)
      upstream.pipe(response)
    } catch {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new DirectMediaError("Seekable media proxy did not bind to TCP")
  }
  const close = () => {
    for (const upstream of upstreams) upstream.destroy()
    server.closeAllConnections()
    server.close()
  }
  options.signal?.addEventListener("abort", close, { once: true })
  return { url: `http://127.0.0.1:${address.port}/media`, close }
}
