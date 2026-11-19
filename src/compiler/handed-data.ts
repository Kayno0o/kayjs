import type { KayFile } from './ast'
import type { ScriptAnalysis } from './script'
import type { ServerAnalysis } from './script-server'
import { templateWords } from './template-reads'

// The fence of a page that is an island with only the server values its script or template read, for the HTML output that builds the island's props: a value only the fence reads stays on the server.
// The analysis pass tells the reads from scopes, so a dynamic access cannot hide one; it leaves out the template's handlers, refs, transitions and loop keys, so any name a template expression writes stays too, and a fence that did not parse hands every one over.
export function handedServer(island: boolean, output: string | undefined, file: KayFile, script: ScriptAnalysis, server: ServerAnalysis | undefined, unread: ReadonlySet<number>): ServerAnalysis | undefined {
  if (!island || output !== 'html' || !server || script.unparsed !== undefined || server.unparsed !== undefined)
    return server

  const words = new Set(templateWords(file))

  return { ...server, data: server.data.filter(data => !unread.has(data.local.start) || words.has(data.name)) }
}
