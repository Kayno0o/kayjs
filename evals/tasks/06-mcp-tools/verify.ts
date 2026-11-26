import type { AssertionResult, VerifyContext } from '../../lib/types'
import { assert, AssertionCollector, readAppSourceFiles } from '../../lib/assertions'

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: Record<string, unknown>
  error?: { code: number, message: string }
}

const TEST_TOKEN = 'kay-eval-mcp-bearer-token-2026'

export async function verify({ dir, app }: VerifyContext): Promise<AssertionResult[]> {
  const c = new AssertionCollector()
  const prevToken = process.env.MCP_TOKEN
  process.env.MCP_TOKEN = TEST_TOKEN

  const rpcHeaders = (token?: string): Record<string, string> => ({
    'content-type': 'application/json',
    'accept': 'application/json',
    ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
  })

  try {
    await c.run('POST /mcp/tools rejects unauthenticated and bad bearer tokens with 401', async () => {
      const noAuth = await app.post('/mcp/tools', { jsonrpc: '2.0', id: 1, method: 'ping' }, rpcHeaders())
      assert(noAuth.status === 401, `expected 401 without Authorization, got ${noAuth.status}`)

      const badAuth = await app.post('/mcp/tools', { jsonrpc: '2.0', id: 2, method: 'ping' }, rpcHeaders('wrong-token'))
      assert(badAuth.status === 401, `expected 401 with invalid Bearer token, got ${badAuth.status}`)
    })

    await c.run('MCP initialize responds with protocolVersion and serverInfo', async () => {
      const res = await app.post(
        '/mcp/tools',
        { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'eval', version: '1.0' } } },
        rpcHeaders(TEST_TOKEN),
      )
      assert(res.status === 200, `expected 200, got ${res.status}`)
      const body = await res.json() as JsonRpcResponse
      assert(body.error === undefined, `unexpected RPC error: ${JSON.stringify(body.error)}`)
      assert(typeof body.result?.protocolVersion === 'string', 'missing result.protocolVersion')
      assert(body.result?.serverInfo !== undefined, 'missing result.serverInfo')
    })

    interface ToolInfo {
      name: string
      description?: string
      inputSchema?: { required?: string[], properties?: Record<string, unknown> }
      annotations?: { readOnlyHint?: boolean }
    }
    let tools: ToolInfo[] = []

    await c.run('MCP tools/list exposes at least 2 typed tools with descriptions', async () => {
      const res = await app.post('/mcp/tools', { jsonrpc: '2.0', id: 4, method: 'tools/list' }, rpcHeaders(TEST_TOKEN))
      assert(res.status === 200, `expected 200, got ${res.status}`)
      const body = await res.json() as JsonRpcResponse
      const listed = body.result?.tools
      assert(Array.isArray(listed), 'result.tools is not an array')
      tools = listed as ToolInfo[]
      assert(tools.length >= 2, `expected at least 2 MCP tools, got ${tools.length}`)
      for (const t of tools) {
        assert(typeof t.name === 'string' && t.name.length > 0, 'tool missing name')
        assert(typeof t.description === 'string' && t.description.length > 0, `tool "${t.name}" missing description`)
      }
      return `tools: ${tools.map(t => t.name).join(', ')}`
    })

    await c.run('MCP tools/call executes a read-only/list tool and validates invalid input', async () => {
      const readTool = tools.find(t => t.annotations?.readOnlyHint === true || /list|get/i.test(t.name)) ?? tools[0]
      assert(readTool !== undefined, 'no tool available to invoke')

      const callRes = await app.post(
        '/mcp/tools',
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: readTool.name, arguments: {} } },
        rpcHeaders(TEST_TOKEN),
      )
      assert(callRes.status === 200, `expected 200, got ${callRes.status}`)
      const callBody = await callRes.json() as JsonRpcResponse
      assert(callBody.error === undefined, `tools/call failed: ${JSON.stringify(callBody.error)}`)
      assert(callBody.result?.isError !== true, `tool "${readTool.name}" returned isError: true`)
      assert(Array.isArray(callBody.result?.content), 'tools/call result missing content array')

      const writeTool = tools.find(t => /create|add|new/i.test(t.name) && t.name !== readTool.name) ?? tools.find(t => t.name !== readTool.name)
      assert(writeTool !== undefined, 'no second tool found for validation check')

      const badRes = await app.post(
        '/mcp/tools',
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: writeTool.name, arguments: { title: '' } } },
        rpcHeaders(TEST_TOKEN),
      )
      assert(badRes.status === 200 || badRes.status === 400, `unexpected status ${badRes.status}`)
      const badBody = await badRes.json() as JsonRpcResponse
      const rejected = badBody.error !== undefined || badBody.result?.isError === true
      assert(rejected, `expected tool "${writeTool.name}" to reject invalid empty input, got ${JSON.stringify(badBody)}`)
    })

    await c.run('config wires @kayjs/mcp with token env, action() tools, and budget', async () => {
      const cfg = await Bun.file(`${dir}/kay.config.ts`).text()
      const sources = [...readAppSourceFiles(dir).values()].join('\n')
      assert(/@kayjs\/mcp/.test(cfg), 'missing @kayjs/mcp import in kay.config.ts')
      assert(/\baction\s*\(/.test(sources), 'missing action() export in src/')
      assert(/\bbudget\b/.test(cfg), 'missing budget configuration in kay.config.ts')
    })
  }
  finally {
    if (prevToken === undefined)
      delete process.env.MCP_TOKEN
    else
      process.env.MCP_TOKEN = prevToken
  }

  return c.results
}
