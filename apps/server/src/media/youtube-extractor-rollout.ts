import { createHmac, randomBytes, randomUUID } from "node:crypto"

import type { Track } from "@discord-music/contracts"

import type { PlayableMedia } from "./types.js"
import type { YouTubeExtractor } from "./youtube-extractor.js"
import {
  type ExtractorRolloutObservation,
  type ExtractorRolloutObservationSink,
  type ExtractorRolloutState,
  MEDIA_SIDECAR_OBSERVATION_SCHEMA,
  SidecarClientDeadlineError,
  SidecarDeadlineError,
  SidecarError,
  type SidecarFailureKind,
  SidecarInternalError,
  SidecarOverloadedError,
  SidecarProtocolError,
  SidecarUnavailableError,
  sidecarFailureKind,
} from "./youtube-sidecar-observation.js"

export type { ExtractorRolloutObservation } from "./youtube-sidecar-observation.js"

const maximumShadowCalls = 32
const fingerprintSalt = randomBytes(32)

export interface SidecarExtractorClient {
  resolve(track: Track, signal?: AbortSignal): Promise<PlayableMedia>
  close(): Promise<void>
}

type ShadowOperation = {
  readonly controller: AbortController
  readonly complete: Promise<void>
}

type RolloutEventContext = {
  readonly correlationId: string
  readonly outcome?: SidecarFailureKind
  readonly trackId?: string
}

type DisabledYouTubeExtractorRolloutOptions = {
  readonly mode: "disabled"
  readonly local: YouTubeExtractor
  readonly observe?: ExtractorRolloutObservationSink
}

type SidecarYouTubeExtractorRolloutOptions = {
  readonly mode: "shadow" | "rust"
  readonly local: YouTubeExtractor
  readonly createSidecar: () => SidecarExtractorClient
  readonly observe?: ExtractorRolloutObservationSink
}

export type YouTubeExtractorRolloutOptions =
  | DisabledYouTubeExtractorRolloutOptions
  | SidecarYouTubeExtractorRolloutOptions

function isFallbackError(error: unknown): boolean {
  return (
    error instanceof SidecarOverloadedError ||
    error instanceof SidecarDeadlineError ||
    error instanceof SidecarClientDeadlineError ||
    error instanceof SidecarInternalError ||
    error instanceof SidecarUnavailableError ||
    error instanceof SidecarProtocolError
  )
}

export class YouTubeExtractorRollout implements YouTubeExtractor {
  private readonly client: SidecarExtractorClient | undefined
  private readonly observe: ExtractorRolloutObservationSink
  private readonly shadow = new Map<string, ShadowOperation>()
  private closePromise: Promise<void> | undefined
  private currentState: ExtractorRolloutState

  constructor(private readonly options: YouTubeExtractorRolloutOptions) {
    this.currentState = options.mode === "disabled" ? "disabled" : "unknown"
    this.client = options.mode === "disabled" ? undefined : options.createSidecar()
    this.observe = options.observe ?? (() => undefined)
  }

  state(): ExtractorRolloutState {
    return this.currentState
  }

  pendingShadow(): number {
    return this.shadow.size
  }

  async resolve(track: Track, signal?: AbortSignal): Promise<PlayableMedia> {
    if (this.closePromise !== undefined)
      throw new SidecarUnavailableError("Sidecar rollout is closed")
    const correlationId = randomUUID()
    switch (this.options.mode) {
      case "disabled":
        return this.local(track, signal, correlationId)
      case "shadow":
        return this.shadowed(track, signal, correlationId)
      case "rust":
        return this.rust(track, signal, correlationId)
    }
  }

  async drain(): Promise<void> {
    await Promise.all([...this.shadow.values()].map(({ complete }) => complete))
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce()
    return this.closePromise
  }

  private async closeOnce(): Promise<void> {
    for (const { controller } of this.shadow.values()) controller.abort()
    await this.drain()
    await this.client?.close()
  }

  private async local(
    track: Track,
    signal: AbortSignal | undefined,
    correlationId: string,
  ): Promise<PlayableMedia> {
    const result = await this.options.local.resolve(track, signal)
    this.event("local_extraction", { correlationId })
    return result
  }

  private async rust(
    track: Track,
    signal: AbortSignal | undefined,
    correlationId: string,
  ): Promise<PlayableMedia> {
    const client = this.requireClient()
    try {
      const result = await client.resolve(track, signal)
      this.currentState = "ready"
      this.event("sidecar_outcome", { correlationId })
      return result
    } catch (error) {
      const outcome = sidecarFailureKind(error)
      if (outcome === "caller_abort") throw error
      this.currentState = "degraded"
      this.event("sidecar_outcome", { correlationId, outcome })
      if (!isFallbackError(error)) throw error
      this.event("fallback", { correlationId, outcome })
      return this.local(track, signal, correlationId)
    }
  }

  async shadowed(
    track: Track,
    signal: AbortSignal | undefined,
    correlationId: string,
  ): Promise<PlayableMedia> {
    const local = await this.local(track, signal, correlationId)
    if (signal?.aborted === true) return local
    if (this.shadow.size >= maximumShadowCalls) {
      this.currentState = "degraded"
      this.event("shadow_skip", { correlationId })
      return local
    }
    this.startShadow(track, signal, correlationId)
    return local
  }

  private startShadow(track: Track, signal: AbortSignal | undefined, correlationId: string): void {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener("abort", abort, { once: true })
    const id = randomUUID()
    const complete = this.requireClient()
      .resolve(track, controller.signal)
      .then(() => {
        this.currentState = "ready"
        this.event("sidecar_outcome", { correlationId })
        this.event("shadow_match", { correlationId, trackId: track.id })
      })
      .catch((error: unknown) => {
        const outcome = sidecarFailureKind(error)
        if (outcome === "caller_abort") return
        this.currentState = "degraded"
        this.event("sidecar_outcome", { correlationId, outcome })
        this.event("shadow_mismatch", { correlationId, outcome, trackId: track.id })
      })
      .finally(() => {
        signal?.removeEventListener("abort", abort)
        this.shadow.delete(id)
      })
    this.shadow.set(id, { controller, complete })
    this.event("shadow_start", { correlationId })
  }

  private requireClient(): SidecarExtractorClient {
    if (this.client === undefined) throw new SidecarError("Sidecar client is unavailable")
    return this.client
  }

  private event(stage: ExtractorRolloutObservation["stage"], context: RolloutEventContext): void {
    this.observe({
      schema: MEDIA_SIDECAR_OBSERVATION_SCHEMA,
      stage,
      correlationId: context.correlationId,
      mode: this.options.mode,
      state: this.currentState,
      pendingShadow: this.shadow.size,
      ...(context.outcome === undefined ? {} : { outcome: context.outcome }),
      ...(context.trackId === undefined
        ? {}
        : {
            fingerprint: createHmac("sha256", fingerprintSalt)
              .update(context.trackId)
              .digest("hex"),
          }),
    })
  }
}

export function createYouTubeExtractorRollout(
  options: YouTubeExtractorRolloutOptions,
): YouTubeExtractorRollout {
  return new YouTubeExtractorRollout(options)
}
