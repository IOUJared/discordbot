export const showcaseStates = [
  "default",
  "hover",
  "active",
  "focus-visible",
  "disabled",
  "loading",
  "empty",
  "error",
] as const

export type ShowcaseState = (typeof showcaseStates)[number]

export const primitiveIds = [
  "app-shell",
  "room-navigation",
  "now-playing",
  "transport",
  "range-control",
  "queue",
  "connection-badge",
  "toast-stack",
] as const

export type PrimitiveId = (typeof primitiveIds)[number]

export const primitiveNames: Record<PrimitiveId, string> = {
  "app-shell": "App shell",
  "room-navigation": "Room navigation",
  "now-playing": "Now-playing panel and artwork",
  transport: "Transport button group",
  "range-control": "Seek / volume range control",
  queue: "Queue list and sheet / drawer",
  "connection-badge": "Connection badge",
  "toast-stack": "Toast stack",
}

const notApplicable: Partial<Record<PrimitiveId, Partial<Record<ShowcaseState, string>>>> = {
  "connection-badge": {
    active: "status has no pressed action; details use a separate trigger",
  },
}

export function notApplicableReason(primitive: PrimitiveId, state: ShowcaseState): string | null {
  return notApplicable[primitive]?.[state] ?? null
}
