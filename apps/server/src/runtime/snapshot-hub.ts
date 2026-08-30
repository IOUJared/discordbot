import type { PlayerState, PlayerStateMessage } from "@discord-music/contracts"

import type { PlayerApi } from "../api/types.js"

export type SnapshotListener = (message: PlayerStateMessage) => void

export class SnapshotHub {
  private version = 0
  private readonly listeners = new Set<SnapshotListener>()
  private readonly unsubscribe: () => void

  constructor(private readonly player: PlayerApi) {
    this.unsubscribe = player.onStateChange(() => this.changed())
  }

  snapshot(): PlayerState {
    return {
      version: this.version,
      player: this.player.snapshot(),
      voice: this.player.voiceStatus(),
      providers: this.player.providerSettings(),
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
    this.listeners.clear()
  }
}
