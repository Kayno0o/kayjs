import { parseKay } from '../compiler/parser'
import { analyzeScript } from '../compiler/script'
import { kayCtxImport } from '../compiler/script-shared'

// A `ctx` that is not the property of another object, followed by the member it reads when that is a plain name.
const CTX = /(?<![\w$])(?<!(?<!\.\.)\.)ctx(?![\w$])(?:\s*\??\.\s*([A-Za-z_$][\w$]*))?/g

// The keys a `.kay` source reads off the `ctx` it takes from kay, or `'all'` when it uses `ctx` any other way, passed whole, spread or indexed, or imports it under another name; none when it imports no `ctx` of kay's.
// A `ctx` in a comment or a string only adds a key or makes it `'all'`, so a page loads more and never fewer. The server fence reads the request's own `ctx`, so it is left out, as is the import naming it.
export function implicitContextKeys(source: string): string[] | 'all' | undefined {
  const parsed = parseKay(source)
  const script = analyzeScript(source, parsed.script, [], parsed.module)
  const imported = kayCtxImport(script.imports)

  if (imported === undefined)
    return undefined

  if (imported.local !== 'ctx')
    return 'all'

  const blank = (text: string, span: { start: number, end: number } | undefined) => span === undefined ? text : text.slice(0, span.start) + ' '.repeat(span.end - span.start) + text.slice(span.end)
  const kept = blank(blank(source, parsed.server), imported.declaration)
  const keys = new Set<string>()

  for (const [, key] of kept.matchAll(CTX)) {
    if (key === undefined)
      return 'all'

    keys.add(key)
  }

  return [...keys]
}
