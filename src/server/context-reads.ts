import { parseKay } from '../compiler/parser'
import { analyzeScript } from '../compiler/script'
import { templateReads } from '../compiler/template-reads'

// Whether a `.kay` source reads `ctx` with no `ctx` of its own, as the compiler decides when it imports the one of kay.
export function readsImplicitContext(source: string): boolean {
  const parsed = parseKay(source)

  return analyzeScript(source, parsed.script, [], templateReads(parsed), parsed.module).implicit.includes('ctx')
}
