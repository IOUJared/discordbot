import type { Track } from "@discord-music/contracts"
import type { PlayableMedia } from "./types.js"

export interface YouTubeExtractor {
  resolve(track: Track, signal?: AbortSignal): Promise<PlayableMedia>
}
