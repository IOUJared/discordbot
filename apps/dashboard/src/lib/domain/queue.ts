export function moveQueueItem<T>(rows: readonly T[], from: number, to: number): readonly T[] {
  const item = rows[from]
  if (item === undefined || to < 0 || to >= rows.length) return rows
  return [...rows.slice(0, from), ...rows.slice(from + 1)].toSpliced(to, 0, item)
}
