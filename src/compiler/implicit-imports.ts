import type { Diagnostic, Fix, KayFile, Span } from './ast'
import type { ServerAnalysis } from './script-server'
import type { ImportBinding, ScriptAnalysis } from './script-shared'

// Where an implicit name is imported from: `kay`, but for the translation function `t`.
const HOMES: Readonly<Record<string, string>> = { t: 'kay/i18n' }

const homeOf = (name: string) => HOMES[name] ?? 'kay'

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

// The text with every comment, string and template literal blanked to spaces, so a search for a name finds code and the offsets stay the file's.
function masked(text: string): string {
  let out = ''
  let i = 0

  while (i < text.length) {
    const char = text[i]!
    const next = text[i + 1]
    let end = i + 1

    if (char === '/' && next === '/') {
      end = text.indexOf('\n', i)
      end = end < 0 ? text.length : end
    }
    else if (char === '/' && next === '*') {
      end = text.indexOf('*/', i + 2)
      end = end < 0 ? text.length : end + 2
    }
    else if (char === '\'' || char === '"' || char === '`') {
      end = i + 1

      while (end < text.length && text[end] !== char) {
        end += text[end] === '\\' ? 2 : 1
      }

      end = Math.min(end + 1, text.length)
    }
    else {
      out += char
      i++

      continue
    }

    out += text.slice(i, end).replaceAll(/[^\n]/g, ' ')
    i = end
  }

  return out
}

// Where the first of `names` is used in `spans`: in the code if it can be found there, else anywhere in the text.
function firstUse(source: string, spans: Span[], names: string[]): Span | undefined {
  const pattern = new RegExp(`(?:(?<![\\w$.])|(?<=\\.\\.\\.))(?:${names.join('|')})(?![\\w$])`, 'g')

  for (const code of [true, false]) {
    let best: Span | undefined

    for (const span of spans) {
      const text = source.slice(span.start, span.end)

      pattern.lastIndex = 0
      const found = pattern.exec(code ? masked(text) : text)

      if (found && (best === undefined || span.start + found.index < best.start))
        best = { start: span.start + found.index, end: span.start + found.index + found[0].length }
    }

    if (best)
      return best
  }

  return undefined
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

function lint(file: KayFile, fence: Span | undefined, imports: readonly ImportBinding[], names: string[], at: Span): Diagnostic {
  const wanted = new Map<string, string[]>()

  for (const name of names)
    wanted.set(homeOf(name), [...wanted.get(homeOf(name)) ?? [], name])

  const written = [...wanted].map(([module, list]) => `\`import { ${list.join(', ')} } from '${module}'\``).join(' and ')
  const listed = names.map(name => `\`${name}\``).join(', ')

  return {
    ...at,
    code: 'implicit-import',
    message: `${listed} ${names.length === 1 ? 'is' : 'are'} used with no import, which kay adds for the file until 1.95`,
    note: 'a `.ts` module imports every name it uses, and code moved between it and a component breaks when the component relied on the import kay added',
    help: `write ${written}`,
    fixes: [{ title: `Import ${listed}`, edits: importEdits(file, fence, imports, wanted), safe: true }],
    checkOnly: true,
  }
}

// The names a file uses with no import, which kay imports for it: the `kay` values the fences and the template read, and `t` of `kay/i18n`.
// A name the server fence uses is imported there, the others in the script fence, else the module fence, else the server fence, else a fence opened before the template.
export function implicitImports(file: KayFile, script: ScriptAnalysis, server: ServerAnalysis | undefined, translates: boolean, ctxTyped: boolean): Diagnostic[] {
  // A fence with a statement that does not parse is being typed: its imports may be the broken statement, and the syntax error says more.
  if ([script, server].some(analysis => analysis !== undefined && (analysis.unparsed !== undefined || analysis.broken.length > 0 || analysis.brokenModule.length > 0)))
    return []

  const imports = [...script.imports, ...server?.imports ?? []]
  const imported = new Set(imports.map(binding => binding.local))
  const keep = (name: string) => !imported.has(name) && !(ctxTyped && name === 'ctx')
  const inServer = new Set((server?.implicit ?? []).filter(keep))
  const inScript = [...new Set([...script.implicit, ...translates ? ['t'] : []])].filter(name => keep(name) && !inServer.has(name))
  const groups = new Map<Span | undefined, string[]>()

  for (const [fence, names] of [[file.server, [...inServer]], [file.script ?? file.module ?? file.server, inScript]] as const) {
    if (names.length > 0)
      groups.set(fence, [...groups.get(fence) ?? [], ...names])
  }

  const spans = [file.script, file.module, file.server, { start: file.templateStart, end: file.source.length }].filter(span => span !== undefined)

  return [...groups].map(([fence, names]) => lint(file, fence, imports, names, firstUse(file.source, spans, names) ?? { start: file.templateStart, end: file.templateStart }))
}
