import type { SiteScope } from './site-scope'
import type { McpTool, TestSite, VisitInit } from './site-types'
import { NativeHeaders, withNatives } from './natives'

export function mcpOf({ defaults, send, mcpKey, mcpUrl }: SiteScope): Pick<TestSite, 'mcp'> {
  interface RpcResult { tools?: McpTool[], isError?: boolean, content?: { text: string }[], structuredContent?: Record<string, unknown> }

  let rpcId = 0

  const rpc = async (method: string, params: object, init: VisitInit = {}): Promise<{ status: number, result: RpcResult }> => {
    const bearer: Record<string, string> = mcpKey === undefined || new NativeHeaders(defaults).has('authorization') ? {} : { authorization: `Bearer ${mcpKey}` }
    const response = await send(mcpUrl(), { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...bearer, ...init.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
    const reply = await withNatives(async () => response.json() as Promise<unknown>) as { result?: RpcResult, error?: { message: string } }

    if (reply.error)
      throw new Error(`kay: ${method} was refused: ${reply.error.message}`)

    return { status: response.status, result: reply.result! }
  }

  return {
    mcp: {
      tools: async init => (await rpc('tools/list', {}, init)).result.tools ?? [],
      call: async (name, args = {}, init) => {
        const { status, result } = await rpc('tools/call', { name, arguments: args }, init)

        return { isError: result.isError === true, text: (result.content ?? []).map(part => part.text).join(''), data: result.structuredContent, status }
      },
    },
  }
}
