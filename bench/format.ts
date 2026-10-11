export function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function milliseconds(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1)
}

export function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = sorted.length >> 1

  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

// The runs' results as one, each number the median of its values across the runs.
export function medianOf<T>(runs: T[]): T {
  const [first] = runs

  if (typeof first === 'number')
    return median(runs as number[]) as T

  if (Array.isArray(first))
    return first.map((_, index) => medianOf(runs.map(run => (run as unknown[])[index]))) as T

  if (typeof first === 'object' && first !== null)
    return Object.fromEntries(Object.keys(first).map(key => [key, medianOf(runs.map(run => (run as Record<string, unknown>)[key]))])) as T

  return first!
}

export function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n')
}
