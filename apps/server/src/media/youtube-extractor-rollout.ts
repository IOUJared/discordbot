import { randomUUID } from "node:crypto"

import type { SearchResult, Track } from "@discord-music/contracts"

import type { PlayableMedia } from "./types.js"
import type { YouTubeExtractor } from "./youtube-extractor.js"
import {
  createRolloutObservation,
  isFallbackError,
  type RolloutEventContext,
} from "./youtube-extractor-rollout-observation.js"
import { RolloutSearch, type ShadowRequest } from "./youtube-extractor-rollout-search.js"
import type { YouTubeSearchClient } from "./youtube-search.js"
import {
  type ExtractorRolloutObservation,
  type ExtractorRolloutObservationSink,
  type ExtractorRolloutState,
  SidecarError,
  SidecarUnavailableError,
  sidecarFailureKind,
} from "./youtube-sidecar-observation.js"

export type { ExtractorRolloutObservation } from "./youtube-sidecar-observation.js"

const maximumShadowCalls = 32
export interface SidecarExtractorClient {
  resolve(track: Track, signal?: AbortSignal): Promise<PlayableMedia>
  search?(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]>
  close(): Promise<void>
}

type ShadowOperation = {
  readonly controller: AbortController
  readonly complete: Promise<void>
}

type RustRequest<Result> = {
  readonly correlationId: string
  readonly sidecar: () => Promise<Result>
  readonly local: () => Promise<Result>
}

type BaseYouTubeExtractorRolloutOptions = {
  readonly local: YouTubeExtractor
  readonly localSearch?: YouTubeSearchClient
  readonly observe?: ExtractorRolloutObservationSink
}

type DisabledYouTubeExtractorRolloutOptions = BaseYouTubeExtractorRolloutOptions & {
  readonly mode: "disabled"
}

type SidecarYouTubeExtractorRolloutOptions = BaseYouTubeExtractorRolloutOptions & {
  readonly mode: "shadow" | "rust"
  readonly createSidecar: () => SidecarExtractorClient
}

export type YouTubeExtractorRolloutOptions =
  | DisabledYouTubeExtractorRolloutOptions
  | SidecarYouTubeExtractorRolloutOptions

export class YouTubeExtractorRollout implements YouTubeExtractor {
  private readonly client: SidecarExtractorClient | undefined
  private readonly observe: ExtractorRolloutObservationSink
  private readonly searchRollout: RolloutSearch
  private readonly shadow = new Map<string, ShadowOperation>()
  private closePromise: Promise<void> | undefined
  private currentState: ExtractorRolloutState

  constructor(private readonly options: YouTubeExtractorRolloutOptions) {
    this.currentState = options.mode === "disabled" ? "disabled" : "unknown"
    this.client = options.mode === "disabled" ? undefined : options.createSidecar()
    this.observe = options.observe ?? (() => undefined)
    this.searchRollout = new RolloutSearch({
      mode: options.mode,
      isClosing: () => this.closePromise !== undefined,
      client: () => this.requireClient(),
      local: () => this.requireLocalSearch(),
      pendingShadow: () => this.shadow.size,
      startShadow: (request) => this.startShadow(request),
      setState: (state) => {
        this.currentState = state
      },
      event: (stage, context) => this.event(stage, context),
    })
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

  async search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]> {
    return this.searchRollout.search(query, signal)
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
    return this.rustRequest({
      correlationId,
      sidecar: () => this.requireClient().resolve(track, signal),
      local: () => this.local(track, signal, correlationId),
    })
  }

  private async rustRequest<Result>(request: RustRequest<Result>): Promise<Result> {
    try {
      const result = await request.sidecar()
      this.currentState = "ready"
      this.event("sidecar_outcome", { correlationId: request.correlationId })
      return result
    } catch (error) {
      const outcome = sidecarFailureKind(error)
      if (outcome === "caller_abort") throw error
      this.currentState = "degraded"
      this.event("sidecar_outcome", { correlationId: request.correlationId, outcome })
      if (!isFallbackError(error)) throw error
      this.event("fallback", { correlationId: request.correlationId, outcome })
      return request.local()
    }
  }

  async shadowed(
    track: Track,
    signal: AbortSignal | undefined,
    correlationId: string,
  ): Promise<PlayableMedia> {
    const local = await this.local(track, signal, correlationId)
    if (this.closePromise !== undefined) return local
    if (signal?.aborted === true) return local
    if (this.shadow.size >= maximumShadowCalls) {
      this.currentState = "degraded"
      this.event("shadow_skip", { correlationId })
      return local
    }
    this.startShadow({
      correlationId,
      ...(signal === undefined ? {} : { signal }),
      run: async (shadowSignal) => {
        await this.requireClient().resolve(track, shadowSignal)
        this.currentState = "ready"
        this.event("sidecar_outcome", { correlationId })
      },
    })
    return local
  }

  private startShadow(request: ShadowRequest): void {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    request.signal?.addEventListener("abort", abort, { once: true })
    const id = randomUUID()
    const complete = Promise.resolve()
      .then(() => {
        if (this.closePromise !== undefined || controller.signal.aborted) return
        return request.run(controller.signal)
      })
      .catch((error: unknown) => {
        const outcome = sidecarFailureKind(error)
        if (outcome === "caller_abort") return
        this.currentState = "degraded"
        this.event("sidecar_outcome", { correlationId: request.correlationId, outcome })
      })
      .finally(() => {
        request.signal?.removeEventListener("abort", abort)
        this.shadow.delete(id)
      })
    this.shadow.set(id, { controller, complete })
    this.event("shadow_start", { correlationId: request.correlationId })
  }

  private requireClient(): SidecarExtractorClient {
    if (this.client === undefined) throw new SidecarError("Sidecar client is unavailable")
    return this.client
  }

  private requireLocalSearch(): YouTubeSearchClient {
    if (this.options.localSearch === undefined)
      throw new SidecarError("Local search is unavailable")
    return this.options.localSearch
  }

  private event(stage: ExtractorRolloutObservation["stage"], context: RolloutEventContext): void {
    this.observe(
      createRolloutObservation({
        stage,
        mode: this.options.mode,
        state: this.currentState,
        pendingShadow: this.shadow.size,
        context,
      }),
    )
  }
}

export function createYouTubeExtractorRollout(
  options: YouTubeExtractorRolloutOptions,
): YouTubeExtractorRollout {
  return new YouTubeExtractorRollout(options)
}
