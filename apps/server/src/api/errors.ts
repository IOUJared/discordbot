import type { PlayerState } from "@discord-music/contracts"

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export class StaleVersionError extends ApiError {
  constructor(readonly snapshot: PlayerState) {
    super(409, "stale_version", "Player state changed")
    this.name = "StaleVersionError"
  }
}

export function errorBody(
  code: string,
  message: string,
): {
  readonly error: { readonly code: string; readonly message: string }
} {
  return { error: { code, message } }
}

export function staleVersionBody(snapshot: PlayerState): {
  readonly error: { readonly code: "stale_version"; readonly message: "Player state changed" }
  readonly snapshot: PlayerState
} {
  return { error: { code: "stale_version", message: "Player state changed" }, snapshot }
}
