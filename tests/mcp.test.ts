import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { missingStore } from '../src/server/not-found'
import { alive } from './alive'
import { eventually } from './helpers/eventually'
import { kayTypes } from './kay-types'
import { spawnSuiteServer } from './listening'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')
const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, paths: kayTypes() },
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

  // `shared` for the one a whole file uses, which a test timing out must not take down.
  constructor(cwd: string, shared = false, args: string[] = []) {
    this.process = shared ? spawnSuiteServer([process.execPath, cli, 'mcp', ...args], { cwd, stdin: 'pipe' }) : Bun.spawn([process.execPath, cli, 'mcp', ...args], { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    void this.listen()
  }

  async request(method: string, params: object = {}): Promise<Reply> {
    const id = ++this.nextId
    const reply = new Promise<Reply>(resolve => this.replies.set(id, resolve))

    this.send({ jsonrpc: '2.0', id, method, params })

    return reply
  }

  async reply(id: number | string | null): Promise<Reply> {
    return new Promise<Reply>(resolve => this.replies.set(id, resolve))
  }

  send(message: object | string): void {
    void this.process.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
    void this.process.stdin.flush()
  }

  // Writes without ending the line.
  sendPartial(text: string): void {
    void this.process.stdin.write(text)
    void this.process.stdin.flush()
  }

  get pid(): number {
    return this.process.pid
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
  agent = new Agent(root, true)
})

afterAll(async () => {
  await agent.close()
  await rm(root, { recursive: true, force: true })
})

// Every process whose working directory is the project's: the commands of a call and what they started.
function processesIn(dir: string, running = ''): number[] {
  const found: number[] = []

  for (const name of readdirSync('/proc')) {
    try {
      if ((/^\d+$/).test(name) && readlinkSync(`/proc/${name}/cwd`) === dir && readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(running))
        found.push(Number(name))
    }
    catch {
      // Gone, or not ours to read.
    }
  }

  return found
}

describe('kay mcp stopping a call', () => {
  it('leaves no process of a render behind once its client is stopped mid-render', async () => {
    const own = await scratchDir('mcp-stop-')

    await Bun.write(join(own, 'tsconfig.json'), tsconfig)
    await Bun.write(join(own, 'src/routes/hang.kay'), `--- server
await Bun.write(${JSON.stringify(join(own, 'serving'))}, String(process.pid))
await Bun.sleep(120_000)
---
p Late
`)

    const stopped = new Agent(own)

    try {
      void stopped.request('tools/call', { name: 'render', arguments: { url: '/hang' } })

      // Read afresh each time, as a file keeps the size it had when it was opened.
      const served = async () => {
        try {
          return await Bun.file(join(own, 'serving')).text()
        }
        catch {
          return ''
        }
      }

      await eventually(async () => expect(await served()).not.toBe(''), 60_000)

      const server = Number(await served())

      expect(server).toBeGreaterThan(0)

      expect(processesIn(own).length).toBeGreaterThan(1)
      process.kill(stopped.pid, 'SIGTERM')

      await eventually(() => expect(processesIn(own)).toEqual([]), 10_000)

      expect(processesIn(own)).toEqual([])
      expect(alive(server)).toBe(false)
    }
    finally {
      await rm(own, { recursive: true, force: true })
    }
  }, 90_000)

  it('leaves no type checker behind once its client is stopped mid-check', async () => {
    const own = await scratchDir('mcp-stop-check-')

    await Bun.write(join(own, 'tsconfig.json'), tsconfig)
    await Bun.write(join(own, 'src/routes/index.kay'), 'p Hi\n')
    // A type that takes the checker a few seconds.
    await Bun.write(join(own, 'src/slow.ts'), `type D = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
type N4 = \`\${D}\${D}\${D}\${D}\`
type A = { [K in N4]: { [J in N4]: K | J } }
type B = { [K in N4]: A[K][N4] }
export const slow: B[N4] = null as never
`)

    const stopped = new Agent(own)

    try {
      void stopped.request('tools/call', { name: 'check', arguments: {} })

      // The checker itself, not a short `--showConfig` run that can end between two reads.
      await eventually(() => expect(processesIn(own, '--listFiles').length).toBeGreaterThan(0), 60_000)

      expect(processesIn(own, '--listFiles').length).toBeGreaterThan(0)
      process.kill(stopped.pid, 'SIGTERM')

      await eventually(() => expect(processesIn(own)).toEqual([]), 5000)

      expect(processesIn(own)).toEqual([])
    }
    finally {
      await rm(own, { recursive: true, force: true })
    }
  }, 90_000)
})

describe('kay mcp calls in one project', () => {
  it('runs them one at a time, in the order they came', async () => {
    const own = await scratchDir('mcp-queue-')

    await Bun.write(join(own, 'tsconfig.json'), tsconfig)

    // Each page notes when its render reached it, then keeps the render going for a second.
    for (const name of ['first', 'second', 'third']) {
      await Bun.write(join(own, `src/routes/${name}.kay`), `--- server
await Bun.write(${JSON.stringify(join(own, name))}, String(Date.now()))
await Bun.sleep(1000)
---
p ${name}
`)
    }

    const queued = new Agent(own)

    try {
      const replies = ['first', 'second', 'third'].map(async name => queued.request('tools/call', { name: 'render', arguments: { url: `/${name}` } }))

      for (const reply of await Promise.all(replies))
        expect(reply.result?.isError).toBe(false)

      const [first, second, third] = await Promise.all(['first', 'second', 'third'].map(async name => Number(await Bun.file(join(own, name)).text())))

      expect(second! - first!).toBeGreaterThanOrEqual(1000)
      expect(third! - second!).toBeGreaterThanOrEqual(1000)
    }
    finally {
      expect(await queued.close()).toBe(0)
      await rm(own, { recursive: true, force: true })
    }
  }, 90_000)

  it('runs the call after one that failed', async () => {
    const own = await scratchDir('mcp-queue-failed-')

    await Bun.write(join(own, 'tsconfig.json'), tsconfig)
    await Bun.write(join(own, 'src/routes/index.kay'), 'p Home\n')

    const queued = new Agent(own)

    try {
      const missing = queued.request('tools/call', { name: 'render', arguments: { url: '/nowhere' } })
      const home = queued.request('tools/call', { name: 'render', arguments: { url: '/' } })

      expect((await missing).result?.isError).toBe(true)
      expect((await home).result?.content?.[0]?.text).toContain('<p>Home</p>')
    }
    finally {
      expect(await queued.close()).toBe(0)
      await rm(own, { recursive: true, force: true })
    }
  }, 90_000)

  it('returns a body that is no text intact, as an image or a blob', async () => {
    const own = await scratchDir('mcp-binary-')
    const bytes = [0x89, 0x50, 0x4E, 0x47, 0xFF, 0xFE, 0x00, 0xC3, 0x28, 0x80]

    await Bun.write(join(own, 'tsconfig.json'), tsconfig)
    await Bun.write(join(own, 'src/routes/pixel.png.ts'), `export function GET() {
  return new Response(new Uint8Array([${bytes.join(', ')}]), { headers: { 'content-type': 'image/png' } })
}
`)
    await Bun.write(join(own, 'src/routes/data.bin.ts'), `export function GET() {
  return new Response(new Uint8Array([${bytes.join(', ')}]), { headers: { 'content-type': 'application/octet-stream' } })
}
`)
    await Bun.write(join(own, 'src/routes/note.txt.ts'), `export function GET() {
  return new Response('plain', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
`)

    const binary = new Agent(own)
    const decoded = (data: unknown) => [...Buffer.from(String(data), 'base64')]

    try {
      const image = await binary.request('tools/call', { name: 'render', arguments: { url: '/pixel.png' } })
      const [picture] = image.result?.content as unknown as { type: string, data: string, mimeType: string }[]

      expect(picture).toMatchObject({ type: 'image', mimeType: 'image/png' })
      expect(decoded(picture?.data)).toEqual(bytes)

      const blob = await binary.request('tools/call', { name: 'render', arguments: { url: '/data.bin' } })
      const [resource] = blob.result?.content as unknown as { type: string, resource: { mimeType: string, blob: string } }[]

      expect(resource?.type).toBe('resource')
      expect(resource?.resource.mimeType).toBe('application/octet-stream')
      expect(decoded(resource?.resource.blob)).toEqual(bytes)

      const text = await binary.request('tools/call', { name: 'render', arguments: { url: '/note.txt' } })

      expect(text.result?.content?.[0]).toEqual({ type: 'text', text: 'plain' })
    }
    finally {
      expect(await binary.close()).toBe(0)
      await rm(own, { recursive: true, force: true })
    }
  }, 90_000)
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

    expect(result).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} }, ttlMs: 0, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'kay' } } })

    const list = await agent.request('tools/list', meta('2026-07-28'))

    expect(list.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' })

    // Every list and read a client may keep says for how long; a ping or a call keeps nothing.
    for (const [method, params] of [['resources/list', {}], ['resources/templates/list', {}], ['resources/read', { uri: 'kay://llms.txt' }]] as const)
      expect((await agent.request(method, { ...params, ...meta('2026-07-28') })).result).toMatchObject({ ttlMs: 0, cacheScope: 'private' })

    expect((await agent.request('ping', meta('2026-07-28'))).result?.ttlMs).toBeUndefined()
    expect((await agent.request('tools/list')).result?.ttlMs).toBeUndefined()

    const refused = await agent.request('tools/list', meta('1999-01-01'))

    expect(refused.error).toMatchObject({ code: -32022, data: { requested: '1999-01-01' } })
    expect(refused.error?.data?.supported).toContain('2026-07-28')
  })

  it('calls a tool in the revision without a handshake too, and narrows a check to a group of lints', async () => {
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
    const { result } = await agent.request('tools/call', { name: 'check', arguments: { only: 'a11y', denyWarnings: true }, _meta: meta })

    expect(result?.resultType).toBe('complete')
    const { problems } = result?.structuredContent as { problems: { code: string }[] }

    expect(problems.map(problem => problem.code)).toContain('missing-alt')
  })

  it('lists its tools with a schema each', async () => {
    const { result } = await agent.request('tools/list')
    const tools = result?.tools as { name: string, inputSchema: { type: string }, annotations: object }[]

    expect(tools.map(tool => tool.name)).toEqual(['check', 'routes', 'explain', 'docs', 'render', 'screenshot', 'doctor', 'fmt', 'generate', 'add', 'test', 'build', 'types', 'fix', 'upgrade', 'lint', 'env', 'i18n_missing', 'a11y', 'dev_errors', 'not_found'])
    expect(tools.every(tool => tool.inputSchema.type === 'object' && 'readOnlyHint' in tool.annotations)).toBe(true)
  })

  it('answers the doctor\'s checks, a failing one being a result', async () => {
    const busy = Bun.serve({ port: 0, hostname: '0.0.0.0', fetch: () => new Response() })

    try {
      const { result } = await agent.request('tools/call', { name: 'doctor', arguments: { port: busy.port } })
      const checks = (result?.structuredContent as { checks: { name: string, ok: boolean }[] }).checks

      expect(checks.map(check => check.name)).toEqual(['bun', 'versions', 'peers', 'tsconfig', 'config', 'env', 'port', 'build', 'browser', 'database', 'complete'])
      expect(checks.find(check => check.name === 'port')!.ok).toBe(false)
      expect(result?.isError).toBeUndefined()
    }
    finally {
      await busy.stop(true)
    }
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

  it('narrows a check to a directory holding a package.json or the project root itself, still checking the project', async () => {
    const nested = await scratchDir('mcp-nested-')

    await Bun.write(join(nested, 'tsconfig.json'), tsconfig)
    await Bun.write(join(nested, 'src/routes/index.kay'), 'img(src="/a.png")\n')
    await Bun.write(join(nested, 'src/routes/pkg/package.json'), '{}')
    await Bun.write(join(nested, 'src/routes/pkg/index.kay'), 'img(src="/b.png")\n')

    const own = new Agent(nested)
    const files = async (paths: string[]) => {
      const reply = await own.request('tools/call', { name: 'check', arguments: { paths } })

      expect(reply.result?.isError).toBeFalsy()

      return (reply.result?.structuredContent as { problems: { file: string, code: string }[] }).problems.filter(problem => problem.code === 'missing-alt').map(problem => problem.file.split('/').slice(-2).join('/'))
    }

    try {
      // The directory is a sub-package the project's check leaves out: nothing to report, and no new project root.
      expect(await files(['src/routes/pkg'])).toEqual([])
      expect(await files(['src/routes/pkg', 'src/routes/index.kay'])).toEqual(['routes/index.kay'])
      expect(await files(['.'])).toEqual(['routes/index.kay'])
      expect(await files(['src/routes/pkg', '.'])).toEqual(['routes/index.kay'])
    }
    finally {
      expect(await own.close()).toBe(0)
    }
  })

  it('refuses a path outside the project or one that is no file, and an argument of the wrong kind', async () => {
    // An argument the model got wrong is a result it can read and retry, not a protocol error.
    for (const paths of [['../outside'], ['missing.kay'], ['/etc'], [3], 'src']) {
      const reply = await agent.request('tools/call', { name: 'check', arguments: { paths } })

      expect(reply.error).toBeUndefined()
      expect(reply.result?.isError).toBe(true)
    }

    expect((await agent.request('tools/call', { name: 'check', arguments: { only: '--help' } })).result?.isError).toBe(true)

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

  it('finds a topic in the docs, and prints the section a label names', async () => {
    const found = (await agent.request('tools/call', { name: 'docs', arguments: { query: 'FormDialog' } })).result?.structuredContent as { sections: { label: string, text: string }[], others: { label: string }[] }

    expect(found.sections[0]!.label).toStartWith('kayjs-ui/forms-and-steps.md#')
    expect(found.sections[0]!.text).toContain('FormDialog')

    const named = (await agent.request('tools/call', { name: 'docs', arguments: { query: found.others[0]!.label } })).result?.structuredContent as { sections: { label: string }[] }

    expect(named.sections[0]!.label).toBe(found.others[0]!.label)
    expect((await agent.request('tools/call', { name: 'docs', arguments: { query: 'zzqqxx' } })).result?.isError).toBe(true)
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

  it('refuses a render that runs an action, and a test run, while the server is read-only', async () => {
    for (const args of [{ url: '/about', method: 'POST' }, { url: '/about', body: 'a=1' }, { url: '/about', method: 'delete' }]) {
      const reply = (await agent.request('tools/call', { name: 'render', arguments: args })).result

      expect(reply?.isError).toBe(true)
      expect(JSON.stringify(reply?.content)).toContain('--write')
    }

    const tested = (await agent.request('tools/call', { name: 'test', arguments: {} })).result

    expect(tested?.isError).toBe(true)
    expect(JSON.stringify(tested?.content)).toContain('--write')

    for (const method of ['GET', 'head', 'OPTIONS'])
      expect(JSON.stringify((await agent.request('tools/call', { name: 'render', arguments: { url: '/about', method } })).result?.content)).not.toContain('--write')
  })

  it('refuses to render what is no path or URL', async () => {
    const reply = await agent.request('tools/call', { name: 'render', arguments: { url: '--help' } })

    expect(reply.result?.isError).toBe(true)
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

  it('serves the llms.txt of each installed library as a resource', async () => {
    const { result } = await agent.request('resources/list')
    const resources = result?.resources as { uri: string }[]

    expect(resources.map(resource => resource.uri)).toContain('kay://kayjs-ui/llms.txt')

    const read = await agent.request('resources/read', { uri: 'kay://kayjs-ui/llms.txt' })

    expect(((read.result?.contents as { text: string }[])[0])?.text).toStartWith('# kayjs-ui')
  })

  it('checks the formatting and previews a generated file without writing', async () => {
    const formatted = (await agent.request('tools/call', { name: 'fmt', arguments: { paths: ['src/routes/about.kay'] } })).result

    await Bun.write(join(root, 'package.json'), '{ "name": "mcp-app", "type": "module", "dependencies": { "kay": "*" } }\n')

    const generated = (await agent.request('tools/call', { name: 'generate', arguments: { kind: 'page', name: 'contact' } })).result

    expect(formatted?.structuredContent).toMatchObject({ written: false, changed: [] })
    expect(generated?.structuredContent).toMatchObject({ kind: 'page', name: 'contact', dryRun: true })
    expect(await Bun.file(join(root, 'src/routes/contact.kay')).exists()).toBe(false)
    expect((await agent.request('tools/call', { name: 'generate', arguments: { kind: '--help', name: 'x' } })).result?.isError).toBe(true)
    // A page would read its first extra argument as the project folder.
    expect((await agent.request('tools/call', { name: 'generate', arguments: { kind: 'page', name: 'x', fields: ['../..'] } })).result?.isError).toBe(true)
    expect((await agent.request('tools/call', { name: 'generate', arguments: { kind: 'page', name: 'x', plural: 'xs' } })).result?.isError).toBe(true)
  })

  it('answers an error result with its document for a file that is not formatted, and takes the project root as a path', async () => {
    const loose = await scratchDir('mcp-fmt-')

    try {
      await Bun.write(join(loose, 'tsconfig.json'), tsconfig)
      await Bun.write(join(loose, 'src/routes/loose.kay'), 'p   Loose\n\n\n\np Again\n')

      const own = new Agent(loose)

      try {
        const file = (await own.request('tools/call', { name: 'fmt', arguments: { paths: ['src/routes/loose.kay'] } })).result
        const whole = (await own.request('tools/call', { name: 'fmt', arguments: { paths: ['.'] } })).result

        expect(file?.isError).toBe(true)
        expect(file?.structuredContent).toMatchObject({ written: false, changed: [expect.stringContaining('loose.kay')] })
        expect(whole?.structuredContent).toMatchObject({ changed: [expect.stringContaining('loose.kay')] })
        expect(await Bun.file(join(loose, 'src/routes/loose.kay')).text()).toBe('p   Loose\n\n\n\np Again\n')
      }
      finally {
        await own.close()
      }
    }
    finally {
      await rm(loose, { recursive: true, force: true })
    }
  })

  it('lists the translations a locale lacks, and refuses a feature holding a comma', async () => {
    const site = await scratchDir('mcp-i18n-')

    try {
      await Bun.write(join(site, 'package.json'), '{ "name": "site", "type": "module", "dependencies": { "kay": "*" } }\n')
      await Bun.write(join(site, 'kay.config.ts'), 'export default { favicon: false, i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\' } }\n')
      await Bun.write(join(site, 'src/messages/en.ts'), 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ nav: { home: \'Home\', about: \'About\' } })\n')
      await Bun.write(join(site, 'src/messages/fr.ts'), 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ nav: { home: \'Accueil\' } })\n')

      const own = new Agent(site)

      try {
        const missing = (await own.request('tools/call', { name: 'i18n_missing', arguments: { locale: 'fr' } })).result
        const unknown = (await own.request('tools/call', { name: 'i18n_missing', arguments: { locale: 'xx' } })).result
        const comma = (await own.request('tools/call', { name: 'add', arguments: { features: ['tailwind,auth'] } })).result

        expect(missing?.structuredContent).toMatchObject({ locales: { fr: { messages: ['nav.about'] } } })
        expect(unknown?.isError).toBe(true)
        expect(comma?.isError).toBe(true)
      }
      finally {
        await own.close()
      }
    }
    finally {
      await rm(site, { recursive: true, force: true })
    }
  })

  it('previews adding a feature, and checks the environment and the translations', async () => {
    const added = (await agent.request('tools/call', { name: 'add', arguments: { features: ['tailwind'] } })).result
    const env = (await agent.request('tools/call', { name: 'env', arguments: {} })).result
    const missing = (await agent.request('tools/call', { name: 'i18n_missing', arguments: {} })).result

    // The fixture's home page is not what `kay new` wrote, so the preview answers why nothing could be added, still as a document.
    expect(added?.structuredContent).toMatchObject({ errors: 1, problems: [{ message: expect.stringContaining('nothing was written') }] })
    expect(env?.structuredContent).toBeDefined()
    expect(missing?.content).toBeDefined()
  })

  it('refuses a resource it does not list, whatever the path says', async () => {
    for (const uri of ['kay://llms/../package.json', 'kay://llms/missing.md', 'file:///etc/passwd'])
      expect((await agent.request('resources/read', { uri })).error).toMatchObject({ code: -32602, message: 'Resource not found', data: { uri } })
  })

  it('answers a message it cannot parse with an error, and keeps serving', async () => {
    const own = new Agent(root)

    try {
      const parseError = own.reply(null)

      own.send('{ not json')
      expect((await parseError).error?.code).toBe(-32700)
      expect((await own.request('ping')).result).toEqual({})
    }
    finally {
      expect(await own.close()).toBe(0)
    }
  })

  it('refuses an id that is no string or number, and a request whose params are no object', async () => {
    const own = new Agent(root)

    try {
      for (const id of [{ a: 1 }, [1], true, false]) {
        const refused = own.reply(null)

        own.send({ jsonrpc: '2.0', id, method: 'ping' })
        expect((await refused).error).toMatchObject({ code: -32600 })
      }

      for (const params of [[1], 'text', 5, true, null]) {
        const refused = own.reply(70)

        own.send({ jsonrpc: '2.0', id: 70, method: 'tools/list', params })
        expect((await refused).error).toMatchObject({ code: -32602 })
      }

      expect((await own.request('ping')).result).toEqual({})
    }
    finally {
      expect(await own.close()).toBe(0)
    }
  })

  it('answers an invalid request with the id it carries when that id is readable', async () => {
    const own = new Agent(root)

    try {
      for (const id of [71, 'seventy-two']) {
        const refused = own.reply(id)

        own.send({ jsonrpc: '2.0', id, method: 5 })
        expect((await refused).error).toMatchObject({ code: -32600 })
      }

      const batch = own.reply(null)

      own.send([{ jsonrpc: '2.0', id: 1, method: 'ping' }])
      expect((await batch).error).toMatchObject({ code: -32600 })
    }
    finally {
      expect(await own.close()).toBe(0)
    }
  })

  it('refuses a line over the cap, drops it up to its newline, and keeps serving', async () => {
    const own = new Agent(root)

    try {
      // Without a newline, then the rest of the line in a later write, then a good request.
      const refused = own.reply(null)

      own.sendPartial(`{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"${'a'.repeat(5 * 1024 * 1024)}`)
      expect((await refused).error).toMatchObject({ code: -32600 })
      own.send('b"}}')
      expect((await own.request('ping')).result).toEqual({})

      // A whole line over the cap in one go.
      const whole = own.reply(null)

      own.send(`{"jsonrpc":"2.0","id":2,"method":"ping","params":{"x":"${'a'.repeat(5 * 1024 * 1024)}"}}`)
      expect((await whole).error).toMatchObject({ code: -32600 })
      expect((await own.request('ping')).result).toEqual({})
    }
    finally {
      expect(await own.close()).toBe(0)
    }
  })

  it('answers the calls made before its input closed, and exits', async () => {
    const own = new Agent(root)
    const reply = own.request('tools/call', { name: 'routes', arguments: {} })

    expect(await own.close()).toBe(0)
    expect((await reply).result?.structuredContent).toHaveProperty('routes')
  })
})

describe('kay mcp tools that write', () => {
  let app: string
  let writer: Agent
  let reader: Agent

  const call = async (who: Agent, name: string, args: object = {}) => (await who.request('tools/call', { name, arguments: args })).result as { isError?: boolean, content: { text: string }[], structuredContent?: Record<string, unknown> }

  beforeAll(async () => {
    app = await scratchDir('mcp-write-')
    await Bun.write(join(app, 'tsconfig.json'), tsconfig)
    await Bun.write(join(app, 'package.json'), '{ "name": "mcp-write", "type": "module", "dependencies": { "kay": "*" } }\n')
    await Bun.write(join(app, 'src/routes/index.kay'), 'p Home\n')
    writer = new Agent(app, false, ['--write'])
    reader = new Agent(app)
  })

  afterAll(async () => {
    await writer.close()
    await reader.close()
    await rm(app, { recursive: true, force: true })
  })

  it('refuses to apply on a server started without --write, and writes nothing', async () => {
    for (const [name, args] of [['generate', { kind: 'page', name: 'refused', apply: true }], ['add', { features: ['tailwind'], apply: true }], ['fix', { apply: true }], ['upgrade', { apply: true }], ['lint', { apply: true }]] as const) {
      const refused = await call(reader, name, args)

      expect(refused.isError).toBe(true)
      expect(refused.content[0]!.text).toContain('--write')
    }

    expect(await Bun.file(join(app, 'src/routes/refused.kay')).exists()).toBe(false)
  })

  it('takes apply as a boolean only', async () => {
    expect((await call(writer, 'generate', { kind: 'page', name: 'x', apply: 'yes' })).isError).toBe(true)
  })

  it('installs only with apply, as a boolean', async () => {
    const preview = await call(writer, 'add', { features: ['tailwind'], install: true })

    expect(preview.isError).toBe(true)
    expect(preview.content[0]!.text).toContain('needs apply')
    expect((await call(writer, 'add', { features: ['tailwind'], apply: true, install: 'yes' })).isError).toBe(true)
  })

  it('previews a generated file by default, and writes it with apply, never over a file that exists', async () => {
    const preview = await call(writer, 'generate', { kind: 'page', name: 'contact' })

    expect(preview.structuredContent).toMatchObject({ dryRun: true })
    expect(await Bun.file(join(app, 'src/routes/contact.kay')).exists()).toBe(false)

    const applied = await call(writer, 'generate', { kind: 'page', name: 'contact', apply: true })

    expect(applied.isError).toBeFalsy()
    expect(await Bun.file(join(app, 'src/routes/contact.kay')).exists()).toBe(true)

    await Bun.write(join(app, 'src/routes/contact.kay'), 'p Mine\n')
    expect((await call(writer, 'generate', { kind: 'page', name: 'contact', apply: true })).isError).toBe(true)
    expect(await Bun.file(join(app, 'src/routes/contact.kay')).text()).toBe('p Mine\n')
  })

  it('keeps a generated name inside the app and out of a shell', async () => {
    const outside = join(app, '..', 'escaped.kay')

    for (const name of ['../../escaped', '/tmp/escaped', '$(touch pwned)', '`touch pwned`', '; touch pwned', '--help'])
      await call(writer, 'generate', { kind: 'page', name, apply: true })

    expect(await Bun.file(outside).exists()).toBe(false)
    expect(await Bun.file(join(app, 'pwned')).exists()).toBe(false)
    expect(await Bun.file('/tmp/escaped.kay').exists()).toBe(false)
  })

  it('fixes a deprecated form only with apply, and previews it before', async () => {
    const source = '--- server\nimport { local } from \'kay\'\n\nconst notes = local({ key: \'id\', read: () => [] })\n\nexport const waiting = () => notes.pending()\n---\np x\n'

    await Bun.write(join(app, 'src/routes/theme.kay'), source)

    const preview = await call(writer, 'fix')

    expect(preview.isError).toBeFalsy()
    expect(await Bun.file(join(app, 'src/routes/theme.kay')).text()).toBe(source)

    await call(writer, 'fix', { apply: true })
    expect(await Bun.file(join(app, 'src/routes/theme.kay')).text()).toContain('notes.unsynced()')
  })

  it('previews adding a feature with nothing installed, and refuses a feature list that smuggles a flag', async () => {
    expect((await call(writer, 'add', { features: ['tailwind,--help'] })).isError).toBe(true)
    expect((await call(writer, 'add', { features: [] })).isError).toBe(true)
    // The fixture's home page is not what `kay new` wrote, so the preview answers why nothing could be added.
    expect((await call(writer, 'add', { features: ['tailwind'] })).structuredContent).toMatchObject({ errors: 1, problems: [{ message: expect.stringContaining('nothing was written') }] })
  })

  it('builds, and writes the types', async () => {
    const built = await call(writer, 'build')

    expect(built.structuredContent).toHaveProperty('problems')
    expect((await call(writer, 'types')).structuredContent).toMatchObject({ dir: '.kay/types' })
  }, 120_000)

  it('renders a POST and runs tests once the server is started with --write', async () => {
    const posted = await call(writer, 'render', { url: '/', method: 'POST', body: 'a=1' })

    expect(JSON.stringify(posted.content)).not.toContain('started without')
  })

  it('lists the failed tests with where they are, and the run\'s output when none can be listed', async () => {
    await Bun.write(join(app, 'tests/mixed.test.ts'), 'import { describe, expect, it } from \'bun:test\'\n\ndescribe(\'group\', () => {\n  it(\'adds\', () => expect(1 + 1).toBe(3))\n  it(\'passes\', () => {})\n})\n\nit(\'throws\', () => {\n  throw new Error(\'boom\\nline 2\')\n})\n')
    await Bun.write(join(app, 'tests/broken.test.ts'), 'import \'./missing\'\n')

    const mixed = await call(writer, 'test', { files: ['tests/mixed.test.ts'] })

    expect(mixed.isError).toBe(true)
    expect(mixed.structuredContent).toMatchObject({ code: 1, failed: [{ file: 'tests/mixed.test.ts', name: 'group > adds', at: 'tests/mixed.test.ts:4', message: expect.stringContaining('Expected: 3') }, { name: 'throws', at: 'tests/mixed.test.ts:8', message: 'boom\nline 2' }] })
    expect(mixed.structuredContent).not.toHaveProperty('summary')

    const broken = await call(writer, 'test', { files: ['tests/broken.test.ts'] })

    expect(broken.isError).toBe(true)
    expect(broken.structuredContent).toMatchObject({ code: 1 })

    const passed = await call(writer, 'test', { files: ['tests/mixed.test.ts'], name: 'passes' })

    expect(passed.structuredContent).toMatchObject({ code: 0, failed: [] })
    // The report file does not stay in the project, and the name pattern is no shell command.
    expect(readdirSync(join(app, '.kay/mcp'))).toEqual([])
    await call(writer, 'test', { name: '"; touch pwned #' })
    expect(await Bun.file(join(app, 'pwned')).exists()).toBe(false)
    expect((await call(writer, 'test', { files: ['../outside'] })).isError).toBe(true)
  }, 120_000)

  it('lints with the project\'s keslint, capped, paths kept inside the project', async () => {
    const bin = join(app, 'node_modules/.bin/keslint')
    const messages = Array.from({ length: 250 }, (_, index) => ({ ruleId: 'no-var', severity: index === 0 ? 2 : 1, message: 'Unexpected var', line: index + 1, column: 1 }))

    await Bun.write(bin, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(join(app, 'lint-args.json'))}, JSON.stringify(process.argv.slice(2)))\nconsole.log(JSON.stringify([{ filePath: ${JSON.stringify(join(app, 'src/a.ts'))}, messages: ${JSON.stringify(messages)} }]))\n`)
    await Bun.$`chmod +x ${bin}`

    const linted = await call(writer, 'lint', { paths: ['src'] })

    expect(linted.structuredContent).toMatchObject({ errors: 1, warnings: 249, omitted: 50 })
    expect(linted.structuredContent!.problems).toHaveLength(200)
    expect((linted.structuredContent!.problems as object[])[0]).toEqual({ file: 'src/a.ts', line: 1, column: 1, severity: 'error', code: 'no-var', message: 'Unexpected var' })
    expect(await Bun.file(join(app, 'lint-args.json')).json()).toEqual(['--format', 'json', './src'])

    await call(writer, 'lint', { apply: true })
    expect(await Bun.file(join(app, 'lint-args.json')).json()).toEqual(['--format', 'json', '--fix', '.'])
    expect((await call(writer, 'lint', { paths: ['../x'] })).isError).toBe(true)
  })

  it('refuses a link that leads out of the project, for lint and test', async () => {
    const outside = await scratchDir('mcp-outside-')

    try {
      await Bun.write(join(outside, 'x.ts'), 'var x = 1\n')
      await symlink(outside, join(app, 'linked'))

      for (const [name, args] of [['lint', { paths: ['linked'], apply: true }], ['lint', { paths: ['linked/x.ts'] }], ['test', { files: ['linked'] }]] as const) {
        const refused = await call(writer, name, args)

        expect(refused.isError).toBe(true)
        expect(refused.content[0]!.text).toContain('not a file or directory inside the project')
      }
    }
    finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses a static build without --write, and keeps a message holding > or a huge entity whole', async () => {
    const refused = await call(reader, 'build', { static: true })

    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toContain('--write')
    expect(await Bun.file(join(app, 'dist')).exists()).toBe(false)

    await Bun.write(join(app, 'tests/angle.test.ts'), 'import { expect, it } from \'bun:test\'\n\nit(\'compares\', () => expect(1 > 2).toBe(true))\nit(\'text\', () => {\n  throw new Error(\'a > b &#x110000;\')\n})\n')

    const listed = await call(writer, 'test', { files: ['tests/angle.test.ts'] })

    expect(listed.structuredContent).toMatchObject({ failed: [{ name: 'compares', at: 'tests/angle.test.ts:3' }, { name: 'text', message: expect.stringContaining('a > b') }] })
  })

  it('waits for the dev errors to change and settle, answering the list as it stands when nothing changes', async () => {
    await mkdir(join(app, '.kay/dev'), { recursive: true })

    const file = join(app, '.kay/dev/errors.json')

    await Bun.write(file, JSON.stringify({ errors: [{ kind: 'request', message: 'before' }] }))

    const waiting = call(writer, 'dev_errors', { waitMs: 20_000 })

    await Bun.sleep(300)
    await Bun.write(file, JSON.stringify({ errors: [{ kind: 'request', message: 'first' }] }))
    await Bun.sleep(150)
    await Bun.write(file, JSON.stringify({ errors: [] }))

    const changed = await waiting

    expect(changed.structuredContent).toMatchObject({ errors: [], waited: true })

    const quiet = await call(writer, 'dev_errors', { waitMs: 500 })

    expect(quiet.structuredContent).toMatchObject({ errors: [], waited: false })
    expect((await call(writer, 'dev_errors', { waitMs: 10_000_000 })).isError).toBe(true)
  })
})

describe('kay mcp not_found', () => {
  let app: string
  let reader: Agent
  const file = () => join(app, 'data', 'not-found.sqlite')

  const call = async (args: object = {}) => (await reader.request('tools/call', { name: 'not_found', arguments: args })).result as { isError?: boolean, content: { text: string }[], structuredContent?: { missing: { path: string, hits: number, lastAt: number, referrers: { host: string }[] }[], total: number } }

  beforeAll(async () => {
    app = await scratchDir('mcp-not-found-')
    await Bun.write(join(app, 'tsconfig.json'), tsconfig)
    await Bun.write(join(app, 'src/routes/index.kay'), 'p Home\n')
    reader = new Agent(app)
  })

  afterAll(async () => {
    await reader.close()
    await rm(app, { recursive: true, force: true })
  })

  it('answers an empty list while nothing is recorded, and creates no database', async () => {
    const result = await call()

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ missing: [], total: 0 })
    expect(await Bun.file(file()).exists()).toBe(false)
  })

  it('lists the recorded paths most hit first and caps them, changing nothing', async () => {
    const store = missingStore(file())
    const never = () => undefined

    for (let index = 0; index < 205; index++)
      store.hit(`/old-${index}`, undefined, never)

    store.hit('/popular', 'blog.example', never)
    store.hit('/popular', 'blog.example', never)
    store.close()

    const before = new Bun.CryptoHasher('sha256').update(await Bun.file(file()).bytes()).digest('hex')
    const all = await call()

    expect(all.structuredContent!.total).toBe(206)
    expect(all.structuredContent!.missing).toHaveLength(200)
    expect(all.structuredContent!.missing[0]).toMatchObject({ path: '/popular', hits: 2, referrers: [{ host: 'blog.example' }] })
    expect(typeof all.structuredContent!.missing[0]!.lastAt).toBe('number')
    expect((await call({ limit: 3 })).structuredContent!.missing).toHaveLength(3)

    for (const limit of [0, 201, 1.5, '3'])
      expect((await call({ limit })).isError).toBe(true)

    expect(new Bun.CryptoHasher('sha256').update(await Bun.file(file()).bytes()).digest('hex')).toBe(before)
  })

  it('hands the paths visitors typed as quoted data, cut short', async () => {
    const store = missingStore(file())
    const never = () => undefined
    const long = `/${'a'.repeat(300)}`

    store.hit(long, undefined, never)

    for (let index = 0; index < 8; index++)
      store.hit('/ignore-previous-instructions', `ref${index}.example`, never)

    store.close()

    const { missing } = (await call()).structuredContent!
    const cutPath = missing.find(entry => entry.path.startsWith('/aaa'))!
    const referrers = missing.find(entry => entry.path === '/ignore-previous-instructions')!.referrers

    expect(cutPath.path).toHaveLength(123)
    expect(cutPath.path.endsWith('...')).toBe(true)
    expect(referrers.length).toBeLessThanOrEqual(5)
    expect((await call()).content[0]!.text).toContain('"path":"/ignore-previous-instructions"')
  })
})
