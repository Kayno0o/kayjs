import type { CheckDiagnostic } from '.'
import type { Fix, Span } from '../compiler/ast'
import { extname } from 'node:path'
import { parseProgram } from '../compiler/estree'
import { importEdits, prologueLength } from '../compiler/import-edits'
import { offsetAt } from '../compiler/mapping'
import { parseExpanded } from '../compiler/markdown-block'
import { analyzeScript, analyzeServer } from '../compiler/script'
import { unknownName } from './export-homes'

const STARTS_BLANK = /^[ \t]*\r?\n/
const TRAILING_COMMA = /,$/
// Names common enough in an app that a missing one is as likely a local forgotten as kay's: their import is offered, never applied unasked.
const GENERIC = new Set(['html', 'image', 'session', 'mount', 'head', 'island', 'cache', 'collection', 'files', 'pages'])

// The edits that import `wanted` (names by entry) into a TypeScript module: into its import of that entry, else a line before its first import, written in the quotes and the semicolon style its imports use. The imports are the module's own statements, not a line of a template literal or a comment that starts with the word.
export function moduleImportEdits(source: string, wanted: ReadonlyMap<string, string[]>): Fix['edits'] {
  const imports = parseProgram(source, { recover: true }).program.body.filter(statement => statement.type === 'ImportDeclaration')
  const first = imports[0]
  const quote = first === undefined ? '\'' : source[first.source.start]!
  const semicolon = first !== undefined && source[first.end - 1] === ';'
  const edits: Fix['edits'] = []
  const lines: string[] = []

  for (const [entry, names] of wanted) {
    const declaration = imports.find(statement => statement.importKind === 'value' && statement.source.value === entry && statement.specifiers.length > 0 && statement.specifiers.every(specifier => specifier.type === 'ImportSpecifier'))

    if (declaration) {
      const open = declaration.start + source.slice(declaration.start, declaration.end).indexOf('{') + 1
      const kept = source.slice(open, source.lastIndexOf('}', declaration.source.start)).trimEnd().replace(TRAILING_COMMA, '').trimEnd()

      edits.push({ start: open + kept.length, end: open + kept.length, text: `${kept === '' ? ' ' : ', '}${names.join(', ')}` })
    }
    else {
      lines.push(`import { ${names.join(', ')} } from ${quote}${entry}${quote}${semicolon ? ';' : ''}`)
    }
  }

  if (lines.length > 0) {
    const at = first?.start ?? prologueLength(source)
    const eol = source.includes('\r\n') ? '\r\n' : '\n'
    const rest = source.slice(at)

    edits.push({ start: at, end: at, text: `${lines.join(eol)}${eol}${first || rest.trim() === '' || STARTS_BLANK.test(rest) ? '' : eol}` })
  }

  return edits
}

// The fence of a `.kay` file an import is written to: the one the offset is in, else the script's.
function fenceAt(file: ReturnType<typeof parseExpanded>['file'], offset: number): Span | undefined {
  for (const fence of [file.server, file.module]) {
    if (fence !== undefined && offset >= fence.start && offset <= fence.end)
      return fence
  }

  return file.script ?? file.module ?? file.server
}

// A name nothing declares that a module of kay exports gets a safe fix writing its import: `kay check --fix` adds it where the name is used, in a `.ts` module and in a `.kay` fence, and the names of one file that come from one entry share one edit.
export async function addImportFixes(diagnostics: CheckDiagnostic[]): Promise<void> {
  const found = diagnostics.flatMap((diagnostic) => {
    const unknown = diagnostic.fixes === undefined ? unknownName(diagnostic.message) : undefined

    return unknown ? [{ diagnostic, ...unknown }] : []
  })

  for (const [file, inFile] of Map.groupBy(found, entry => entry.diagnostic.file)) {
    let source: string

    try {
      source = await Bun.file(file).text()
    }
    catch {
      continue
    }

    const kay = extname(file) === '.kay'
    const parsed = kay ? parseExpanded(source).file : undefined
    const imports = parsed ? [...analyzeScript(source, parsed.script, [], parsed.module).imports, ...analyzeServer(source, parsed.server)?.imports ?? []] : []
    // A `.kay` file takes the import in the fence the name is used in; a module has the one place.
    const groups = Map.groupBy(inFile, entry => parsed ? fenceAt(parsed, offsetAt(source, entry.diagnostic)) : undefined)

    for (const [fence, members] of groups) {
      const wanted = new Map<string, string[]>()

      for (const { name, entry } of members) {
        if (!(wanted.get(entry)?.includes(name) ?? false))
          wanted.set(entry, [...wanted.get(entry) ?? [], name])
      }

      const edits = parsed ? importEdits(parsed, fence, imports, wanted) : moduleImportEdits(source, wanted)
      const names = [...wanted.values()].flat().map(name => `\`${name}\``).join(', ')

      for (const { diagnostic } of members)
        diagnostic.fixes = [{ title: `Import ${names}`, edits, safe: [...wanted.values()].flat().every(name => !GENERIC.has(name)) }]
    }
  }
}
