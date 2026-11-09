import type { Fix, KayFile, Span } from './ast'
import type { ImportBinding } from './script-shared'

const STARTS_WITH_IMPORT = /^\s*import\b/
const STARTS_BLANK = /^[ \t]*\r?\n/
const PROLOGUE_LINE = /^(?:#!.*|\/\/\/\s*<reference\b.*|[ \t]*(['"])use [\w -]+\1[ \t]*(?:;[ \t]*)?)(?:\r?\n|$)/

// How far a module's prologue reaches: the shebang, the `/// <reference>` directives and the `'use strict'` or `"use client"` directives it opens with, which an import goes below.
export function prologueLength(text: string): number {
  let end = 0

  for (let line = PROLOGUE_LINE.exec(text); line && line[0] !== ''; line = PROLOGUE_LINE.exec(text.slice(end)))
    end += line[0].length

  return end
}

// The edits that write `wanted` (the names by the module they come from) into the fence: into the import of that module it already has, else as an import of its own at the fence's start. With no fence the file gets a `---` one before its template.
export function importEdits(file: KayFile, fence: Span | undefined, imports: readonly ImportBinding[], wanted: ReadonlyMap<string, string[]>): Fix['edits'] {
  const edits: Fix['edits'] = []
  const lines: string[] = []

  for (const [module, names] of wanted) {
    const into = fence === undefined
      ? undefined
      : imports.filter(binding => binding.source === module && !binding.typeOnly && binding.imported !== 'default' && binding.imported !== '*' && binding.declaration.start >= fence.start && binding.declaration.end <= fence.end).toSorted((a, b) => a.span.end - b.span.end).at(-1)

    if (into)
      edits.push({ start: into.span.end, end: into.span.end, text: `, ${names.join(', ')}` })
    else
      lines.push(`import { ${names.join(', ')} } from '${module}'`)
  }

  if (lines.length > 0) {
    const eol = file.source.includes('\r\n') ? '\r\n' : '\n'
    const body = fence === undefined ? '' : file.source.slice(fence.start, fence.end)
    const skip = prologueLength(body)
    const at = (fence?.start ?? file.templateStart) + skip
    const rest = body.slice(skip)
    // A blank line sets the imports off from the code that follows, unless the code already starts with one.
    const apart = rest.trim() !== '' && !STARTS_WITH_IMPORT.test(rest) && !STARTS_BLANK.test(rest) ? eol : ''

    edits.push({ start: at, end: at, text: fence ? `${lines.join(eol)}${eol}${apart}` : `---${eol}${lines.join(eol)}${eol}---${eol}` })
  }

  return edits
}
