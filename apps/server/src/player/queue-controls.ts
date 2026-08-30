import type { QueueItem } from "@discord-music/contracts"

import { PlayerQueue } from "./queue.js"

export class QueueControls {
  protected readonly queue = new PlayerQueue()

  constructor(private readonly random: () => number) {}

  remove(id: QueueItem["id"]): QueueItem {
    return this.queue.remove(id)
  }

  clear(): void {
    this.queue.clear()
  }

  move(id: QueueItem["id"], index: number): void {
    this.queue.move(id, index)
  }

  playNext(id: QueueItem["id"]): void {
    this.queue.playNext(id)
  }

  shuffle(): void {
    this.queue.shuffle(this.random)
  }
}
