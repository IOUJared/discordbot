import type {
  MediaProviderSettings,
  MediaSourcePreference,
  SearchResult,
  Track,
} from "@discord-music/contracts"

export type PlayableMedia = {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly container: string
  readonly codec: string
  readonly seekable: boolean
}

export interface MusicSource {
  search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]>
  resolve(track: Track, signal?: AbortSignal): Promise<PlayableMedia>
}

export interface ProviderController {
  settings(): MediaProviderSettings
  setPreference(preference: MediaSourcePreference): void
  connectMockTidal(): void
  disconnectMockTidal(): void
  close(): Promise<void>
}

export type ProcessRequest = {
  readonly file: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export type ProcessOutput = {
  readonly stdout: string
  readonly stderr: string
}

export interface ProcessExecutor {
  run(request: ProcessRequest): Promise<ProcessOutput>
}
