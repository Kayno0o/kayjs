import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')
const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})

interface Reply {
  id?: number | string | null
  result?: Record<string, unknown> & { content?: { type: string, text: string }[], contents?: { uri: string, text: string }[] }
  error?: { code: number, message: string, data?: { supported?: string[] } }
}

// Drives `kay mcp` over stdio the way an agent's client does, one JSON message per line.
class Agent {
  private readonly process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private readonly replies = new Map<number | string | null, (reply: Reply) => void>()
  private nextId = 0

  constructor(cwd: string) {
    this.process = Bun.spawn([process.execPath, cli, 'mcp'], { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    void this.listen()
  }

  async request(method: string, params: object = {}): Promise<Reply> {
    const id = ++this.nextId
    const reply = new Promise<Reply>(resolve => this.replies.set(id, resolve))

    this.send({ jsonrpc: '2.0', id, method, params })

    return reply
  }

  send(message: object | string): void {
    void this.process.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
    void this.process.stdin.flush()
  }

  async close(): Promise<number> {
    await this.process.stdin.end()

    return this.process.exited
  }

  private async listen(): Promise<void> {
    let buffer = ''

    for await (const chunk of this.process.stdout) {
      buffer += new TextDecoder().decode(chunk)

      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const reply = JSON.parse(buffer.slice(0, end)) as Reply

        buffer = buffer.slice(end + 1)
        this.replies.get(reply.id ?? null)?.(reply)
      }
    }
  }
}

let root: string
let agent: Agent

beforeAll(async () => {
  root = await scratchDir('mcp-')
  await Bun.write(join(root, 'tsconfig.json'), tsconfig)
  await Bun.write(join(root, 'src/routes/index.kay'), 'img(src="/a.png")\n')
  await Bun.write(join(root, 'src/routes/about.kay'), 'p About\n')
  agent = new Agent(root)
})

afterAll(async () => {
  await agent.close()
  await rm(root, { recursive: true, force: true })
})

describe.concurrent('kay mcp', () => {
  it('opens with initialize as the revisions before 2026-07-28 do, answering the version asked for when it speaks it', async () => {
    const { result } = await agent.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })

    expect(result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'kay' } })
    expect(typeof result?.instructions).toBe('string')

    const unknown = await agent.request('initialize', { protocolVersion: '1999-01-01' })

    expect(unknown.result?.protocolVersion).toBe('2025-11-25')
    // Notifications and pings are accepted, the first with no answer.
    agent.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect((await agent.request('ping')).result).toEqual({})
  })

  it('answers the revision carrying its version in every request, and refuses one it does not speak', async () => {
    const meta = (protocolVersion: string) => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': protocolVersion, 'io.modelcontextprotocol/clientCapabilities': {} } })
    const { result } = await agent.request('server/discover', meta('2026-07-28'))

    expect(result).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'kay' } } })

    const list = await agent.request('tools/list', meta('2026-07-28'))

    expect(list.result?.resultType).toBe('complete')

    const refused = await agent.request('tools/list', meta('1999-01-01'))

    expect(refused.error).toMatchObject({ code: -32022, data: { requested: '1999-01-01' } })
    expect(refused.error?.data?.supported).toContain('2026-07-28')
  })

  it('lists its tools with a schema each', async () => {
    const { result } = await agent.request('tools/list')
    const tools = result?.tools as { name: string, inputSchema: { type: string }, annotations: object }[]

    expect(tools.map(tool => tool.name)).toEqual(['check', 'routes', 'explain', 'render', 'dev_errors'])
    expect(tools.every(tool => tool.inputSchema.type === 'object' && 'readOnlyHint' in tool.annotations)).toBe(true)
  })

  it('checks the project, or only the files given, a lint being a result and not a failure', async () => {
    const whole = await agent.request('tools/call', { name: 'check', arguments: {} })
    const document = whole.result?.structuredContent as { errors: number, problems: { file: string, code: string, line: number }[] }

    expect(whole.result?.isError).toBeFalsy()
    expect(document.problems.map(problem => [problem.file.split('/').at(-1), problem.code, problem.line])).toContainEqual(['index.kay', 'missing-alt', 1])
    expect(JSON.parse(whole.result?.content?.[0]?.text ?? '')).toEqual(document)

    const narrowed = await agent.request('tools/call', { name: 'check', arguments: { paths: ['src/routes/about.kay'] } })

    expect((narrowed.result?.structuredContent as typeof document).problems).toEqual([])
  })

  it('refuses a path outside the project or one that is no file, and an argument of the wrong kind', async () => {
    for (const paths of [['../outside'], ['missing.kay'], ['/etc'], [3], 'src'])
      expect((await agent.request('tools/call', { name: 'check', arguments: { paths } })).error?.code).toBe(-32602)

    // A name that looks like a flag is a name, not an option.
    const flag = await agent.request('tools/call', { name: 'explain', arguments: { name: '--help' } })

    expect(flag.result?.isError).toBe(true)
    expect((await agent.request('tools/call', { name: 'nope' })).error).toMatchObject({ code: -32602, message: 'Unknown tool: nope' })
    expect((await agent.request('nope')).error?.code).toBe(-32601)
  })

  it('lists the routes', async () => {
    const { result } = await agent.request('tools/call', { name: 'routes', arguments: {} })
    const { routes } = result?.structuredContent as { routes: { path: string, kind: string }[] }

    expect(routes.filter(route => route.kind === 'page').map(route => route.path).toSorted()).toEqual(['/', '/about'])
  })

  it('explains lints and error codes alike', async () => {
    const all = (await agent.request('tools/call', { name: 'explain', arguments: {} })).result?.structuredContent as { lints: { name: string }[], errors: { name: string }[] }

    expect(all.lints.map(lint => lint.name)).toContain('missing-alt')
    expect(all.errors.length).toBeGreaterThan(0)

    const lint = (await agent.request('tools/call', { name: 'explain', arguments: { name: 'missing-alt' } })).result?.structuredContent as { name: string, wrong: string }
    const code = (await agent.request('tools/call', { name: 'explain', arguments: { name: all.errors[0]!.name } })).result?.structuredContent as { name: string, fix: object }

    expect(lint).toMatchObject({ name: 'missing-alt' })
    expect(code).toMatchObject({ name: all.errors[0]!.name })
    expect((await agent.request('tools/call', { name: 'explain', arguments: { name: 'not-a-lint' } })).result?.isError).toBe(true)
  })

  it('reads the dev server\'s errors from the file it writes, an empty list when it has not run', async () => {
    const none = await agent.request('tools/call', { name: 'dev_errors', arguments: {} })

    expect(none.result?.structuredContent).toMatchObject({ errors: [] })

    await mkdir(join(root, '.kay/dev'), { recursive: true })
    await Bun.write(join(root, '.kay/dev/errors.json'), JSON.stringify({ errors: [{ kind: 'request', time: 'now', message: 'boom', report: 'boom' }] }))

    const some = await agent.request('tools/call', { name: 'dev_errors', arguments: {} })

    expect(some.result?.structuredContent).toMatchObject({ errors: [{ kind: 'request', message: 'boom' }] })

    await Bun.write(join(root, '.kay/dev/errors.json'), '{ half')
    expect((await agent.request('tools/call', { name: 'dev_errors', arguments: {} })).result?.isError).toBe(true)
  })

  it('renders a URL as the server answers it, a missing page being an error result that keeps the status', async () => {
    const page = await agent.request('tools/call', { name: 'render', arguments: { url: '/about', headers: ['accept-language: en'] } })

    expect(page.result?.isError).toBe(false)
    expect(page.result?.content?.[0]?.text).toContain('<p>About</p>')
    expect(page.result?.content?.[1]?.text).toContain('200')

    const missing = await agent.request('tools/call', { name: 'render', arguments: { url: '/nowhere' } })

    expect(missing.result?.isError).toBe(true)
    expect(missing.result?.content?.[1]?.text).toContain('404')
  })

  it('refuses to render what is no path or URL', async () => {
    const reply = await agent.request('tools/call', { name: 'render', arguments: { url: '--help' } })

    expect(reply.error?.code).toBe(-32602)
  })

  it('serves the llms files as resources, the index first', async () => {
    const { result } = await agent.request('resources/list')
    const resources = result?.resources as { uri: string, name: string, title: string, description: string, mimeType: string }[]

    expect(resources[0]).toMatchObject({ uri: 'kay://llms.txt', mimeType: 'text/markdown' })
    expect(resources.map(resource => resource.uri)).toContain('kay://llms/checks.md')
    expect(resources.find(resource => resource.uri === 'kay://llms/checks.md')).toMatchObject({ title: 'Checks and lints', description: expect.stringContaining('Sections: ') })

    const read = await agent.request('resources/read', { uri: 'kay://llms/checks.md' })
    const [content] = read.result?.contents as { uri: string, text: string }[]

    expect(content?.uri).toBe('kay://llms/checks.md')
    expect(content?.text).toStartWith('# Checks and lints')
    expect(((await agent.request('resources/read', { uri: 'kay://llms.txt' })).result?.contents as { text: string }[])[0]?.text).toStartWith('# kay')
  })

  it('refuses a resource it does not list, whatever the path says', async () => {
    for (const uri of ['kay://llms/../package.json', 'kay://llms/missing.md', 'file:///etc/passwd'])
      expect((await agent.request('resources/read', { uri })).error).toMatchObject({ code: -32602, message: 'Resource not found', data: { uri } })
  })

  it('answers a message it cannot parse with an error, and keeps serving', async () => {
    const own = new Agent(root)

    try {
      own.send('{ not json')
      expect((await own.request('ping')).result).toEqual({})
    }
    finally {
      expect(await own.close()).toBe(0)
    }
  })
})
