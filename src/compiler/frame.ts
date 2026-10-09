import type { Diagnostic, Labelled } from './ast'
import { positionAt } from './mapping'

const CONTEXT_LINES = 2

export type Style = 'bold' | 'red' | 'yellow' | 'blue' | 'cyan'

// Colours a part of a report; the terminal passes one, every other reader takes the text as it is.
export type Paint = (styles: Style[], text: string) => string

export interface Report extends Pick<Diagnostic, 'message' | 'label' | 'related' | 'note' | 'help' | 'code' | 'severity'> {
  file: string
  line: number
  column: number
  // The source the report points into, and its span there; without it only the location is printed.
  frame?: { source: string, start: number, end: number } | undefined
}

interface Mark extends Labelled {
  primary: boolean
}

const plain: Paint = (_styles, text) => text

// The lines leading to `start`, then carets under the span, clipped to its first line.
export function codeFrame(source: string, start: number, end = start + 1): string {
  return frameRows(source, { start, end, label: '', primary: true }, [], plain).rows.join('\n')
}

// rustc's layout: `error[code]: message`, where it is, the lines involved with the span underlined, then why and what to do instead.
export function formatReport(report: Report, paint: Paint = plain): string {
  const severity = report.severity ?? 'error'
  const colour: Style = severity === 'error' ? 'red' : 'yellow'
  const heading = `${paint(['bold', colour], `${severity}${report.code !== undefined && report.code !== '' ? `[${report.code}]` : ''}`)}${paint(['bold'], `: ${report.message}`)}`
  const frame = report.frame && frameRows(report.frame.source, { start: report.frame.start, end: report.frame.end, label: report.label ?? '', primary: true }, report.related ?? [], paint, colour)
  const width = frame?.width ?? String(report.line).length
  const gutter = paint(['bold', 'blue'], `${' '.repeat(width)} |`)
  const lines = [heading, `${' '.repeat(width)}${paint(['bold', 'blue'], '-->')} ${report.file}:${report.line}:${report.column}`]

  if (frame)
    lines.push(gutter, ...frame.rows)

  const footer = [['note', report.note], ['help', report.help]].filter((entry): entry is [string, string] => entry[1] !== undefined)

  if (footer.length > 0)
    lines.push(gutter, ...footer.map(([kind, text]) => `${' '.repeat(width + 1)}${paint(['bold', 'blue'], '=')} ${paint(['bold'], `${kind}:`)} ${text}`))

  return lines.join('\n')
}

// The primary span's line and the lines leading to it, each related span's line, and a mark under every span: `^` the primary one, `-` the others.
function frameRows(source: string, primary: Mark, related: Labelled[], paint: Paint, colour: Style = 'red'): { width: number, rows: string[] } {
  const lines = source.split('\n')
  const marks = [primary, ...related.map(span => ({ ...span, primary: false }))].map((mark) => {
    const { line, column } = positionAt(source, mark.start)
    const text = lines[line - 1] ?? ''

    return { ...mark, line, column, length: Math.max(1, Math.min(mark.end - mark.start, text.length - column + 1)) }
  })
  const primaryLine = marks[0]!.line
  const shown = new Set(marks.map(mark => mark.line))

  for (let number = Math.max(1, primaryLine - CONTEXT_LINES); number < primaryLine; number++)
    shown.add(number)

  const numbers = [...shown].sort((a, b) => a - b)
  const width = String(numbers.at(-1)).length
  const bar = (number?: number) => paint(['bold', 'blue'], `${number === undefined ? ' '.repeat(width) : String(number).padStart(width)} |`)
  const rows: string[] = []

  for (const [index, number] of numbers.entries()) {
    if (index > 0 && number - numbers[index - 1]! > 1)
      rows.push(paint(['bold', 'blue'], '...'))

    rows.push(`${bar(number)} ${lines[number - 1]}`)

    for (const mark of marks.filter(candidate => candidate.line === number).sort((a, b) => a.column - b.column)) {
      const underline = `${(mark.primary ? '^' : '-').repeat(mark.length)}${mark.label ? ` ${mark.label}` : ''}`

      rows.push(`${bar()} ${' '.repeat(mark.column - 1)}${paint(mark.primary ? ['bold', colour] : ['bold', 'blue'], underline)}`)
    }
  }

  return { width, rows }
}

export function formatDiagnostic(source: string, filename: string, diagnostic: Diagnostic, paint?: Paint): string {
  return formatReport({ ...diagnostic, file: filename, ...positionAt(source, diagnostic.start), frame: { source, start: diagnostic.start, end: diagnostic.end } }, paint)
}
