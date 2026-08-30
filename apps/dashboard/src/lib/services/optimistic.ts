import { moveQueueItem } from "../domain/queue.js"

type Commit<T> = (rows: readonly T[]) => void
type MutationResult = { readonly ok: boolean; readonly status: number }

export async function optimisticReorder<T>(
  rows: readonly T[],
  from: number,
  to: number,
  commit: Commit<T>,
  mutate: () => Promise<MutationResult>,
  refetch: () => Promise<void>,
): Promise<"committed" | "rolled-back"> {
  commit(moveQueueItem(rows, from, to))
  const result = await mutate()
  if (result.ok) return "committed"
  commit(rows)
  if (result.status === 409) await refetch()
  return "rolled-back"
}
