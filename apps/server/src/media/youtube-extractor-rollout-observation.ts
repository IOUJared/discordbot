import { createHmac, randomBytes } from "node:crypto"

import {
  type ExtractorRolloutMode,
  type ExtractorRolloutObservation,
  type ExtractorRolloutState,
  MEDIA_SIDECAR_OBSERVATION_SCHEMA,
  SidecarClientDeadlineError,
  SidecarDeadlineError,
  type SidecarFailureKind,
  SidecarInternalError,
  SidecarOverloadedError,
  SidecarProtocolError,
  SidecarUnavailableError,
} from "./youtube-sidecar-observation.js"

const fingerprintSalt = randomBytes(32)

export type RolloutEventContext = {
  readonly correlationId: string
  readonly outcome?: SidecarFailureKind
  readonly trackIds?: readonly string[]
}

type RolloutObservationInput = {
  readonly mode: ExtractorRolloutMode
  readonly state: ExtractorRolloutState
  readonly pendingShadow: number
  readonly stage: ExtractorRolloutObservation["stage"]
  readonly context: RolloutEventContext
}

export function isFallbackError(error: unknown): boolean {
  return (
    error instanceof SidecarOverloadedError ||
    error instanceof SidecarDeadlineError ||
    error instanceof SidecarClientDeadlineError ||
    error instanceof SidecarInternalError ||
    error instanceof SidecarUnavailableError ||
    error instanceof SidecarProtocolError
  )
}

export function createRolloutObservation(
  input: RolloutObservationInput,
): ExtractorRolloutObservation {
  return {
    schema: MEDIA_SIDECAR_OBSERVATION_SCHEMA,
    stage: input.stage,
    correlationId: input.context.correlationId,
    mode: input.mode,
    state: input.state,
    pendingShadow: input.pendingShadow,
    ...(input.context.outcome === undefined ? {} : { outcome: input.context.outcome }),
    ...(input.context.trackIds === undefined
      ? {}
      : {
          fingerprint: createHmac("sha256", fingerprintSalt)
            .update(JSON.stringify(input.context.trackIds))
            .digest("hex"),
        }),
  }
}
