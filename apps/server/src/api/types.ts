import type {
  ChannelId,
  LoopMode,
  PlaybackFailureNotification,
  PlayerSnapshot,
  QueueItem,
  QueueItemId,
  SearchResult,
  Track,
  UserId,
  VoiceStatus,
  Volume,
  YouTubePlaylist,
} from "@discord-music/contracts"

export interface PlayerApi {
  snapshot(): PlayerSnapshot
  voiceStatus(): VoiceStatus
  onStateChange(listener: () => void): () => void
  onPlaybackFailure(listener: (notification: PlaybackFailureNotification) => void): () => void
  play(query: string, requestedBy: UserId, channelId: ChannelId): Promise<QueueItem>
  enqueue(track: Track, requestedBy: UserId): Promise<QueueItem>
  enqueueMany(tracks: readonly Track[], requestedBy: UserId): Promise<readonly QueueItem[]>
  startIfIdle(): Promise<void>
  remove(id: QueueItemId): QueueItem
  clear(): void
  move(id: QueueItemId, index: number): void
  playNext(id: QueueItemId): void
  playSelected(id: QueueItemId): Promise<void>
  pause(): boolean
  resume(): boolean
  skip(): Promise<void>
  next(): Promise<void>
  stop(): void
  restart(): Promise<void>
  seek(offsetMs: number): Promise<void>
  setVolume(volume: Volume): void
  setLoop(loopMode: LoopMode): void
  shuffle(): void
  join(channelId: ChannelId): Promise<void>
  leave(): Promise<void>
}

export interface SearchApi {
  search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]>
  playlist(url: string, signal?: AbortSignal): Promise<YouTubePlaylist>
}

export type VoiceChannel = {
  readonly id: ChannelId
  readonly name: string
  readonly memberCount: number
}
