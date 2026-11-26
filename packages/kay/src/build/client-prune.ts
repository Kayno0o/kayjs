// The browser's copy of a module it loads only for the islands declared in it: the code those islands reach, without the server code around them.

import type { Declaration, ImportDeclaration, ModuleExportName, Node, Program } from 'oxc-parser'
import type { ModuleAnalysis } from '../compiler/analyze'
import { parseTsx } from '../compiler/analyze'
import { clientReach } from '../compiler/interactivity'
import { SourceEditor } from '../compiler/patch'
import { collectPatternNames } from '../compiler/shared'

/** The top-level names the browser needs to run the islands `localNames` of a module: the bindings they reach and the imports those name. */
export function clientNeeds(analysis: Pick<ModuleAnalysis, 'bindings'>, localNames: readonly string[]): Set<string> {
  const keep = new Set<string>()
  for (const b of clientReach(analysis.bindings, localNames)) {
    keep.add(b.name)
    for (const ref of b.refs.keys())
      keep.add(ref)
  }
  return keep
}

/** The analysis of the client copy `keep` gives, for the walk of what the browser loads: its imports, dynamic imports and program. */
export function clientView(analysis: ModuleAnalysis, code: string, keep: ReadonlySet<string>): ModuleAnalysis {
  const pruned = pruneForClient(code, analysis.program, keep)
  if (pruned === code)
    return analysis
  const spans = analysis.bindings.filter(b => b.name === '' || keep.has(b.name))
  return {
    ...analysis,
    program: parseTsx(analysis.filename, pruned),
    imports: analysis.imports.flatMap((imp) => {
      if (imp.specifiers.length === 0)
        return [imp]
      const specifiers = imp.specifiers.filter(s => keep.has(s.local))
      return specifiers.length === 0 ? [] : [{ ...imp, specifiers }]
    }),
    reexports: [],
    dynamicImports: analysis.dynamicImports.filter(d => spans.some(b => d.start >= b.start && d.start < b.end)),
  }
}

/** `code` with each top-level declaration, import and re-export outside `keep` removed. Everything else (module-level statements, types) stays. */
export function pruneForClient(code: string, program: Program, keep: ReadonlySet<string>): string {
  const editor = new SourceEditor(code)
  for (const stmt of program.body) {
    const text = keptText(stmt, code, keep)
    if (text !== undefined)
      editor.replace(stmt.start, stmt.end, text)
  }
  return editor.toString()
}

const nameOf = (name: ModuleExportName): string => name.type === 'Identifier' ? name.name : String(name.value)

function declaredNames(decl: Declaration): string[] | undefined {
  if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration')
    return decl.id === null ? undefined : [decl.id.name]
  if (decl.type !== 'VariableDeclaration')
    return undefined
  const names = new Set<string>()
  for (const d of decl.declarations)
    collectPatternNames(d.id, names)
  return [...names]
}

/** The text replacing a top-level statement: `''` to drop it, `undefined` to leave it as written. */
function keptText(stmt: Node, code: string, keep: ReadonlySet<string>): string | undefined {
  switch (stmt.type) {
    case 'ImportDeclaration':
      return keptImport(stmt, code, keep)
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'VariableDeclaration': {
      const names = declaredNames(stmt)
      return names === undefined || names.some(n => keep.has(n)) ? undefined : ''
    }
    case 'ExportNamedDeclaration': {
      if (stmt.exportKind === 'type')
        return undefined
      if (stmt.declaration !== null && stmt.declaration !== undefined) {
        const names = declaredNames(stmt.declaration)
        return names === undefined || names.some(n => keep.has(n)) ? undefined : ''
      }
      if (stmt.source !== null)
        return ''
      const specs = stmt.specifiers.filter(s => keep.has(nameOf(s.local)))
      if (specs.length === stmt.specifiers.length)
        return undefined
      return specs.length === 0 ? '' : `export { ${specs.map(s => code.slice(s.start, s.end)).join(', ')} };`
    }
    case 'ExportDefaultDeclaration': {
      const decl = stmt.declaration
      const name = decl.type === 'Identifier' ? decl.name : (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id !== null ? decl.id.name : 'default'
      return keep.has(name) ? undefined : ''
    }
    case 'ExportAllDeclaration':
      return stmt.exportKind === 'type' ? undefined : ''
    default:
      return undefined
  }
}

function keptImport(stmt: ImportDeclaration, code: string, keep: ReadonlySet<string>): string | undefined {
  // A type import or one with attributes stays as written; a side-effect import keeps all of its zero specifiers.
  if (stmt.importKind === 'type' || (stmt.attributes?.length ?? 0) > 0)
    return undefined
  // A type specifier is erased with the types, so it stays whatever uses it.
  const specs = stmt.specifiers.filter(s => keep.has(s.local.name) || (s.type === 'ImportSpecifier' && s.importKind === 'type'))
  if (specs.length === stmt.specifiers.length)
    return undefined
  const source = code.slice(stmt.source.start, stmt.source.end)
  return specs.map((s) => {
    if (s.type === 'ImportDefaultSpecifier')
      return `import ${s.local.name} from ${source};`
    if (s.type === 'ImportNamespaceSpecifier')
      return `import * as ${s.local.name} from ${source};`
    return `import { ${code.slice(s.start, s.end)} } from ${source};`
  }).join(' ')
}
