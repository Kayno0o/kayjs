import type { Span } from '../compiler/ast'
import type { FormatOptions } from '../compiler/format'
import { formatKay } from '../compiler/format'
import { parseKay } from '../compiler/parser'

export interface RangeEdit extends Span {
  text: string
}

const NEWLINE = /\n/g

// The edits formatting the top-level blocks of the template that the range touches, each as `formatKay` writes it in a whole file. The formatter works on whole files and a line indented alone would change what it nests under, so a range grows to the blocks it touches; the fences are left as they are, and so is a file that does not parse.
export function formatRange(source: string, range: Span, options: FormatOptions = {}): RangeEdit[] {
  const file = parseKay(source)

  if (file.diagnostics.length > 0)
    return []

  // A range ending at the start of a line does not touch it.
  const last = range.end > range.start && source[range.end - 1] === '\n' ? range.end - 1 : range.end
  const starts = file.template.map((node, index) => index === 0 ? firstStart(source, node.start) : source.lastIndexOf('\n', node.start - 1) + 1)
  const crlf = source.includes('\r\n')
  const edits: RangeEdit[] = []

  for (const [index, node] of file.template.entries()) {
    const from = starts[index]!
    const next = starts[index + 1]
    const to = next ?? source.length

    if (node.end < range.start || from > last)
      continue

    // The block's trailing blank lines fold into one blank line or none, as in a whole file.
    const text = source.slice(from, to)
    const body = text.trimEnd()
    const formatted = formatKay(body, options)

    if (formatted.diagnostics.length > 0)
      continue

    const blank = next !== undefined && (text.slice(body.length).match(NEWLINE)?.length ?? 0) >= 2
    const written = formatted.code + (blank ? '\n' : '')
    const replacement = crlf ? written.replaceAll('\n', '\r\n') : written

    if (replacement !== text)
      edits.push({ start: from, end: to, text: replacement })
  }

  return edits
}

// The first block takes the blank lines before it, which a whole file drops: they run from the line after what precedes it, the closing line of a fence.
function firstStart(source: string, at: number): number {
  const before = source.slice(0, at).trimEnd()

  return before === '' ? 0 : source.indexOf('\n', before.length - 1) + 1
}
