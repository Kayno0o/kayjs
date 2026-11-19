import type { ScriptAnalysis } from './script'
import type { ServerAnalysis } from './script-server'

// The fence of a page that is an island with only the server values its script or template read, which the analysis pass tells from scopes, so a dynamic access cannot hide one.
// The island's props go into the page's source, so a value only the fence reads stays on the server; a fence that did not parse hands every one over.
export function handedServer(island: boolean, script: ScriptAnalysis, server: ServerAnalysis | undefined, unread: ReadonlySet<number>): ServerAnalysis | undefined {
  if (!island || !server || script.unparsed !== undefined || server.unparsed !== undefined)
    return server

  return { ...server, data: server.data.filter(data => !unread.has(data.local.start)) }
}
