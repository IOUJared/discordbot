import type { SearchResult } from "@discord-music/contracts"
import type { SidecarExtractorClient } from "./youtube-extractor-rollout.js"
import {
  isFallbackError,
  type RolloutEventContext,
} from "./youtube-extractor-rollout-observation.js"
import type { YouTubeSearchClient } from "./youtube-search.js"
import {
  type ExtractorRolloutMode,
  type ExtractorRolloutObservation,
  type ExtractorRolloutState,
  requestCorrelationId,
  SidecarError,
  SidecarUnavailableError,
  sidecarFailureKind,
} from "./youtube-sidecar-observation.js"

export type ShadowRequest = {
  readonly correlationId: string
  readonly signal?: AbortSignal
  readonly run: (signal: AbortSignal) => Promise<void>
}

type SearchRolloutDependencies = {
  readonly mode: ExtractorRolloutMode
  readonly isClosing: () => boolean
  readonly client: () => SidecarExtractorClient
  readonly local: () => YouTubeSearchClient
  readonly pendingShadow: () => number
  readonly startShadow: (request: ShadowRequest) => void
  readonly setState: (state: ExtractorRolloutState) => void
  readonly event: (
    stage: ExtractorRolloutObservation["stage"],
    context: RolloutEventContext,
  ) => void
}

export class RolloutSearch {
  constructor(private readonly dependencies: SearchRolloutDependencies) {}

  async search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]> {
    if (this.dependencies.isClosing())
      throw new SidecarUnavailableError("Sidecar rollout is closed")
    const correlationId = requestCorrelationId(signal)
    switch (this.dependencies.mode) {
      case "disabled":
        return this.localSearch(query, signal, correlationId)
      case "shadow":
        return this.shadowSearch(query, signal, correlationId)
      case "rust":
        return this.rustSearch(query, signal, correlationId)
    }
  }

  private async localSearch(
    query: string,
    signal: AbortSignal | undefined,
    correlationId: string,
  ): Promise<readonly SearchResult[]> {
    const results = await this.dependencies.local().search(query, signal)
    this.dependencies.event("local_extraction", { correlationId })
    return results
  }

  private async rustSearch(
    query: string,
    signal: AbortSignal | undefined,
    correlationId: string,
  ): Promise<readonly SearchResult[]> {
    try {
      const results = await this.sidecarSearch(query, signal)
      this.dependencies.setState("ready")
      this.dependencies.event("sidecar_outcome", { correlationId })
      return results
    } catch (error) {
      const outcome = sidecarFailureKind(error)
      if (outcome === "caller_abort") {
        this.dependencies.event("sidecar_outcome", { correlationId, outcome })
        throw error
      }
      this.dependencies.setState("degraded")
      this.dependencies.event("sidecar_outcome", { correlationId, outcome })
      if (!isFallbackError(error)) throw error
      this.dependencies.event("fallback", { correlationId, outcome })
      return this.localSearch(query, signal, correlationId)
    }
  }

  private async shadowSearch(
    query: string,
    signal: AbortSignal | undefined,
    correlationId: string,
  ): Promise<readonly SearchResult[]> {
    const local = await this.localSearch(query, signal, correlationId)
    if (this.dependencies.isClosing() || signal?.aborted === true) return local
    if (this.dependencies.pendingShadow() >= 32) {
      this.dependencies.setState("degraded")
      this.dependencies.event("shadow_skip", { correlationId })
      return local
    }
    this.dependencies.startShadow({
      correlationId,
      ...(signal === undefined ? {} : { signal }),
      run: async (shadowSignal) => {
        const remote = await this.sidecarSearch(query, shadowSignal)
        const localIds = local.map(({ track }) => track.id)
        const remoteIds = remote.map(({ track }) => track.id)
        const matches =
          localIds.length === remoteIds.length &&
          localIds.every((id, index) => id === remoteIds.at(index))
        this.dependencies.setState(matches ? "ready" : "degraded")
        this.dependencies.event("sidecar_outcome", { correlationId })
        this.dependencies.event(matches ? "shadow_match" : "shadow_mismatch", {
          correlationId,
          trackIds: localIds,
        })
      },
    })
    return local
  }

  private async sidecarSearch(
    query: string,
    signal: AbortSignal | undefined,
  ): Promise<readonly SearchResult[]> {
    const search = this.dependencies.client().search
    if (search === undefined) throw new SidecarError("Sidecar search is unavailable")
    return search(query, signal)
  }
}
