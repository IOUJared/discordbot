import type {
  BitrateKbps,
  SearchResult,
  Track,
  YouTubePlaylist,
} from "@discord-music/contracts"
import type { RemoteMediaUrl } from "./media-url-policy.js"

type MediaMetadata = {
  readonly headers: Readonly<Record<string, string>>
  readonly container: string
  readonly codec: string
  readonly bitrateKbps: BitrateKbps | null
  readonly seekable: boolean
}

export type LocalPlayableMedia = MediaMetadata & { readonly kind: "local"; readonly url: string }
export type RemotePlayableMedia = MediaMetadata & {
  readonly kind: "remote"
  readonly url: RemoteMediaUrl
}
export type PlayableMedia = LocalPlayableMedia | RemotePlayableMedia

export interface MusicSource {
  search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]>
  resolve(track: Track, signal?: AbortSignal): Promise<PlayableMedia>
}

export interface PlaylistSource {
  playlist(url: string, signal?: AbortSignal): Promise<YouTubePlaylist>
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
