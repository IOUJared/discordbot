import type {
  PlaybackFailureMessage,
  PlayerState,
  PlayerStateMessage,
} from "@discord-music/contracts"

import type { PlayerApi } from "../api/types.js"

export type SnapshotListener = (message: PlayerStateMessage | PlaybackFailureMessage) => void

export class SnapshotHub {
  private version = 0
  private readonly listeners = new Set<SnapshotListener>()
  private readonly unsubscribe: () => void
  private readonly unsubscribeFailures: () => void

  constructor(private readonly player: PlayerApi) {
    this.unsubscribe = player.onStateChange(() => this.changed())
    this.unsubscribeFailures = player.onPlaybackFailure((payload) => {
      const message = { version: 1, type: "playback.failed", payload } as const
      for (const listener of this.listeners) listener(message)
    })
  }

  snapshot(): PlayerState {
    return {
      version: this.version,
      player: this.player.snapshot(),
      voice: this.player.voiceStatus(),
    }
  }

  changed(): PlayerState {
    this.version += 1
    const payload = this.snapshot()
    const message = { version: 1, type: "state.snapshot", payload } as const
    for (const listener of this.listeners) listener(message)
    return payload
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.unsubscribe()
    this.unsubscribeFailures()
    this.listeners.clear()
  }
}
