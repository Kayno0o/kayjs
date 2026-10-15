import type { ServerAnalysis } from '../compiler/script'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { falseKeys } from '../server/routes'

export interface ServerFacts {
  // The `server` fence analysed, undefined when the file has none.
  server: ServerAnalysis | undefined
  // Whether the `page` settings leave the layouts above out, `layouts: false`.
  leavesLayoutsOut: boolean
}

// More files than any app has; a cache past it starts over rather than growing with every file an editor session ever opened.
const LIMIT = 4096
const facts = new Map<string, { text: string, facts: ServerFacts }>()

// What a file's server fence says, parsed once per change of its text: the shadows of every page under a layout, the action clashes and the query clashes all read the same layouts, and the LSP asks again on every save.
export function serverFacts(file: string, text: string): ServerFacts {
  const known = facts.get(file)

  if (known?.text === text)
    return known.facts

  const found = { server: analyzeServer(text, parseKay(text).server), leavesLayoutsOut: falseKeys(text).has('layouts') }

  if (facts.size >= LIMIT)
    facts.clear()

  facts.set(file, { text, facts: found })

  return found
}
