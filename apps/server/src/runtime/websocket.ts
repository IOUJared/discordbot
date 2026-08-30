import type { FastifyInstance } from "fastify"
import type { WebSocket } from "ws"
import { wsAuthSchema } from "../api/schemas.js"
import type { SessionStore } from "../auth/session-auth.js"
import type { SnapshotHub } from "./snapshot-hub.js"

const policyViolation = 1008

export function registerWebSocket(
  app: FastifyInstance,
  deps: {
    readonly frontendOrigin: string
    readonly sessions: SessionStore
    readonly snapshots: SnapshotHub
    readonly authTimeoutMs?: number
    readonly correctionMs?: number
  },
): void {
  app.get("/ws", { websocket: true }, (socket, request) => {
    if (request.headers.origin !== deps.frontendOrigin) {
      socket.close(policyViolation, "origin_rejected")
      return
    }
    let authenticated = false
    let unsubscribe: (() => void) | null = null
    let correction: NodeJS.Timeout | null = null
    const timeout = setTimeout(() => {
      if (!authenticated) socket.close(policyViolation, "auth_timeout")
    }, deps.authTimeoutMs ?? 5_000)

    socket.once("message", (data) => {
      const parsed = parseAuth(data.toString())
      if (parsed === null || deps.sessions.authorize(parsed.token) === null) {
        clearTimeout(timeout)
        socket.close(policyViolation, "unauthorized")
        return
      }
      authenticated = true
      clearTimeout(timeout)
      sendSnapshot(socket, deps.snapshots)
      unsubscribe = deps.snapshots.subscribe((message) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
      })
      correction = setInterval(
        () => sendSnapshot(socket, deps.snapshots),
        deps.correctionMs ?? 5_000,
      )
    })
    socket.on("close", () => {
      clearTimeout(timeout)
      unsubscribe?.()
      if (correction !== null) clearInterval(correction)
    })
  })
}

function parseAuth(value: string): { readonly type: "auth"; readonly token: string } | null {
  try {
    const parsed = wsAuthSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

function sendSnapshot(socket: WebSocket, snapshots: SnapshotHub): void {
  if (socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify({ version: 1, type: "state.snapshot", payload: snapshots.snapshot() }))
}
