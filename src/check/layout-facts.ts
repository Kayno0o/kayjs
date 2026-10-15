import type { ServerAnalysis } from '../compiler/script'
import { createHash } from 'node:crypto'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { falseKeys } from '../server/routes'

export interface ServerFacts {
  // The `server` fence analysed, undefined when the file has none.
  server: ServerAnalysis | undefined
  // Whether the `page` settings leave the layouts above out, `layouts: false`.
  leavesLayoutsOut: boolean
}

// More files than any app has; a cache past it drops its oldest entry rather than growing with every file an editor session ever opened.
const LIMIT = 4096
// Keyed by a hash of the text, so a long session keeps no file's text.
const facts = new Map<string, { hash: string, facts: ServerFacts }>()

// What a file's server fence says, parsed once per change of its text: the shadows of every page under a layout, the action clashes and the query clashes all read the same layouts, and the LSP asks again on every save.
export function serverFacts(file: string, text: string): ServerFacts {
  const known = facts.get(file)
  // Not `Bun.hash`: the ESLint plugin reads this too, in a process that is not Bun's.
  const hash = createHash('sha1').update(text).digest('base64')

  if (known?.hash === hash)
    return known.facts

  const found = { server: analyzeServer(text, parseKay(text).server), leavesLayoutsOut: falseKeys(text).has('layouts') }

  // Deleted first so a file read again is the newest.
  facts.delete(file)

  if (facts.size >= LIMIT)
    facts.delete(facts.keys().next().value!)

  facts.set(file, { hash, facts: found })

  return found
}
