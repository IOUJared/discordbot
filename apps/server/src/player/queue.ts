import type { QueueItem, QueueItemId } from "@discord-music/contracts"

export class QueueItemMissingError extends Error {
  constructor(readonly queueItemId: QueueItemId) {
    super(`Queue item does not exist: ${queueItemId}`)
    this.name = "QueueItemMissingError"
  }
}

export class DuplicateQueueItemError extends Error {
  constructor(readonly queueItemId: QueueItemId) {
    super(`Queue item ID already exists: ${queueItemId}`)
    this.name = "DuplicateQueueItemError"
  }
}

export class PlayerQueue {
  private readonly items: QueueItem[]

  constructor(initial: readonly QueueItem[] = []) {
    this.items = []
    for (const item of initial) this.push(item)
  }

  list(): readonly QueueItem[] {
    return [...this.items]
  }

  push(item: QueueItem): void {
    if (this.items.some(({ id }) => id === item.id)) throw new DuplicateQueueItemError(item.id)
    this.items.push(item)
  }

  shift(): QueueItem | undefined {
    return this.items.shift()
  }

  clear(): void {
    this.items.splice(0)
  }

  remove(id: QueueItemId): QueueItem {
    const index = this.items.findIndex((item) => item.id === id)
    if (index < 0) throw new QueueItemMissingError(id)
    const removed = this.items.splice(index, 1).at(0)
    if (removed === undefined) throw new QueueItemMissingError(id)
    return removed
  }

  move(id: QueueItemId, targetIndex: number): void {
    const item = this.remove(id)
    const boundedIndex = Math.max(0, Math.min(targetIndex, this.items.length))
    this.items.splice(boundedIndex, 0, item)
  }

  playNext(id: QueueItemId): void {
    this.move(id, 0)
  }

  shuffle(random: () => number): void {
    for (let index = this.items.length - 1; index > 0; index -= 1) {
      const target = Math.floor(random() * (index + 1))
      const current = this.items[index]
      const replacement = this.items[target]
      if (current === undefined || replacement === undefined) continue
      this.items[index] = replacement
      this.items[target] = current
    }
  }
}
