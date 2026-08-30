import { PlayerStateMessageSchema } from "./schemas.js"

export type ControlContext = {
  readonly hasCurrent: boolean
  readonly connected: boolean
  readonly paused: boolean
  readonly busy: boolean
}

export function controlsFor(context: ControlContext) {
  return {
    canPause: context.hasCurrent && !context.paused && !context.busy,
    canResume: context.hasCurrent && context.paused && !context.busy,
    canSkip: context.hasCurrent && !context.busy,
    canStop: context.hasCurrent && !context.busy,
    canSeek: context.hasCurrent && context.connected && !context.busy,
  }
}

export function requireVoiceSelection(connected: boolean, channelId: string): boolean {
  return connected || channelId.trim().length > 0
}

export function parseSnapshotMessage(value: unknown) {
  return PlayerStateMessageSchema.safeParse(value)
}
