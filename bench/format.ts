export function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function milliseconds(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1)
}

export function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n')
}
