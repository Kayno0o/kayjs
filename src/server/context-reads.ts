import { parseKay } from '../compiler/parser'
import { analyzeScript } from '../compiler/script'
import { templateReads } from '../compiler/template-reads'

// A `ctx` that is not the property of another object, followed by the member it reads when that is a plain name.
const CTX = /(?<![\w$])(?<!(?<!\.\.)\.)ctx(?![\w$])(?:\s*\??\.\s*([A-Za-z_$][\w$]*))?/g

// The keys a `.kay` source reads off the `ctx` it takes from kay, or `'all'` when it uses `ctx` any other way, passed whole, spread or indexed; none when the template reads no `ctx` of kay's, as the compiler decides when it imports the one of kay.
// A `ctx` in a comment or a string only adds a key or makes it `'all'`, so a page loads more and never fewer. The server fence reads the request's own `ctx`, so it is left out.
export function implicitContextKeys(source: string): string[] | 'all' | undefined {
  const parsed = parseKay(source)

  if (!analyzeScript(source, parsed.script, [], templateReads(parsed), parsed.module).implicit.includes('ctx'))
    return undefined

  const fence = parsed.server
  const kept = fence === undefined ? source : source.slice(0, fence.start) + ' '.repeat(fence.end - fence.start) + source.slice(fence.end)
  const keys = new Set<string>()

  for (const [, key] of kept.matchAll(CTX)) {
    if (key === undefined)
      return 'all'

    keys.add(key)
  }

  return [...keys]
}
