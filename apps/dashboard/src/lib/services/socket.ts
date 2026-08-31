import type { PlaybackFailureNotification, PlayerState } from "@discord-music/contracts"
import { nextReconnectDelay } from "../domain/playback.js"
import { SocketMessageSchema } from "../domain/schemas.js"
import type { VoiceChannel } from "./api.js"

export type SocketStatus = "connecting" | "connected" | "reconnecting" | "disconnected"
type Options = {
  readonly url: string
  readonly token: string
  readonly onState: (state: PlayerState) => void
  readonly onStatus: (status: SocketStatus) => void
  readonly onFailure: (failure: PlaybackFailureNotification) => void
  readonly onChannels: (channels: readonly VoiceChannel[]) => void
  readonly refresh: () => Promise<void>
  readonly random?: () => number
}

export function connectSnapshotSocket(options: Options): () => void {
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let cancelled = false
  const random = options.random ?? Math.random
  const open = (): void => {
    if (cancelled) return
    options.onStatus(attempt === 0 ? "connecting" : "reconnecting")
    socket = new WebSocket(options.url)
    socket.addEventListener("open", () => {
      socket?.send(JSON.stringify({ type: "auth", token: options.token }))
      attempt = 0
      options.onStatus("connected")
    })
    socket.addEventListener("message", (event) => {
      let raw: unknown
      try {
        raw = JSON.parse(String(event.data))
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        return
      }
      const parsed = SocketMessageSchema.safeParse(raw)
      if (!parsed.success) return
      switch (parsed.data.type) {
        case "state.snapshot":
          options.onState(parsed.data.payload)
          return
        case "playback.failed":
          options.onFailure(parsed.data.payload)
          return
        case "voice.channels":
          options.onChannels(parsed.data.payload.channels)
          return
      }
    })
    socket.addEventListener("close", () => {
      if (cancelled) return
      options.onStatus("reconnecting")
      const delay = nextReconnectDelay(attempt, random)
      attempt += 1
      timer = setTimeout(() => {
        void options.refresh().finally(open)
      }, delay)
    })
    socket.addEventListener("error", () => socket?.close())
  }
  open()
  return () => {
    cancelled = true
    if (timer !== null) clearTimeout(timer)
    socket?.close()
    options.onStatus("disconnected")
  }
}
