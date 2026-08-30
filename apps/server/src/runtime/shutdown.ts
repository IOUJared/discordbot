export type Closable = { close(): void | Promise<void> }

export function createShutdown(resources: readonly Closable[]): () => Promise<void> {
  let closing: Promise<void> | null = null
  return async () => {
    if (closing === null) {
      closing = (async () => {
        for (const resource of resources) await resource.close()
      })()
    }
    await closing
  }
}
