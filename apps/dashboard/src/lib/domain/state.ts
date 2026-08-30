import { PlayerStateMessageSchema, SocketMessageSchema } from "./schemas.js"

export type ControlContext = {
  readonly hasCurrent: boolean
  readonly connected: boolean
  readonly paused: boolean
  readonly busy: boolean
  readonly seekable: boolean
}

export function controlsFor(context: ControlContext) {
  return {
    canPause: context.hasCurrent && !context.paused && !context.busy,
    canResume: context.hasCurrent && context.paused && !context.busy,
    canSkip: context.hasCurrent && !context.busy,
    canStop: context.hasCurrent && !context.busy,
    canSeek: context.hasCurrent && context.connected && context.seekable && !context.busy,
  }
}

export function requireVoiceSelection(connected: boolean, channelId: string): boolean {
  return connected || channelId.trim().length > 0
}

export function parseSnapshotMessage(value: unknown) {
  return PlayerStateMessageSchema.safeParse(value)
}

export function parseSocketMessage(value: unknown) {
  return SocketMessageSchema.safeParse(value)
}
