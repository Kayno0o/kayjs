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

export function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n')
}
