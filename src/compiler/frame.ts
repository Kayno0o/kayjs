import { positionAt } from './mapping'

const CONTEXT_LINES = 2

// The lines leading to `start`, then carets under the span, clipped to its first line.
export function codeFrame(source: string, start: number, end = start + 1): string {
  const { line, column } = positionAt(source, start)
  const lines = source.split('\n')
  const width = String(line).length
  const text = lines[line - 1] ?? ''
  const carets = Math.max(1, Math.min(end - start, text.length - column + 1))
  const rows: string[] = []

  for (let number = Math.max(1, line - CONTEXT_LINES); number <= line; number++)
    rows.push(`${String(number).padStart(width)} | ${lines[number - 1]}`)

  rows.push(`${' '.repeat(width)} | ${' '.repeat(column - 1)}${'^'.repeat(carets)}`)

  return rows.join('\n')
}
