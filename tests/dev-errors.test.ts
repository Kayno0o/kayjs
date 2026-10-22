import type { Mock } from 'bun:test'
import type { DevError } from '../src/server/dev-errors'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { runCommand } from '../src/commands/command'
import { dev as devCommand } from '../src/commands/dev'
import { answeredWithoutError, DEV_ERRORS_FILE, recordRequestError, trackDevErrors } from '../src/server/dev-errors'
import { freePort } from './free-port'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const CLI = join(import.meta.dir, '../src/cli.ts')
const saved = process.env.KAY_DEV_CODE

function listed(root: string, path?: string): DevError[] | undefined {
  const file = join(outputDir(root), DEV_ERRORS_FILE)

  const errors = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { errors: DevError[] }).errors : undefined

  return path === undefined ? errors : errors?.filter(error => error.request?.path === path || (error.request === undefined && path === 'boot'))
}

async function until(condition: () => boolean, timeout = 5000) {
  for (const start = Date.now(); !condition(); await Bun.sleep(20)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

// A page that throws while its flag file exists.
async function throwingPage(root: string, file: string): Promise<string> {
  const flag = join(root, `${file}.broken`)

  await Bun.write(join(root, file), `--- server\nimport { existsSync } from 'node:fs'\nif (existsSync(${JSON.stringify(flag)})) throw new Error('load broke')\n---\np ok\n`)
  writeFileSync(flag, '')

  return flag
}

// One process serves one project, so every server of this file serves this one.
let root = ''
// The errors these servers meet are logged as well, as expected.
let logged: Mock<typeof console.error> | undefined

describe('the errors kay dev lists for a reader without a browser', () => {
  beforeAll(async () => {
    logged = spyOn(console, 'error').mockImplementation(() => undefined)
    process.env.KAY_DEV_CODE = 'test'
    root = await scratchDir('dev-errors-')
    await Bun.write(join(root, 'src/routes/index.kay'), 'p ok\n')
  })

  afterAll(() => {
    logged?.mockRestore()

    if (saved === undefined)
      delete process.env.KAY_DEV_CODE
    else
      process.env.KAY_DEV_CODE = saved
  })

  it('lists a request that threw, its stack on `.kay` lines and the lines leading to the throw, until it is answered without one', async () => {
    const flag = await throwingPage(root, 'src/routes/thrown.kay')
    const other = await throwingPage(root, 'src/routes/other.kay')
    const app = await pages({ root, dev: true, prebuilt: false })

    expect((await app.handle(new Request('http://localhost/thrown?query=dropped'))).status).toBe(500)
    expect(listed(root, '/thrown')).toEqual([{ kind: 'request', time: expect.any(String), request: { method: 'GET', path: '/thrown' }, message: 'load broke', report: expect.stringMatching(/^Error: load broke\n\s+at .*src\/routes\/thrown\.kay:3:\d+/), at: { file: 'src/routes/thrown.kay', line: 3, column: expect.any(Number), frame: expect.stringContaining(`3 | if (existsSync(`) } }])
    expect((await app.handle(new Request('http://localhost/other'))).status).toBe(500)

    rmSync(flag)
    expect((await app.handle(new Request('http://localhost/thrown'))).status).toBe(200)
    await until(() => listed(root, '/thrown')?.length === 0)
    // Another path failing stays listed, until it too is answered.
    expect(listed(root, '/other')).toHaveLength(1)
    rmSync(other)
    expect((await app.handle(new Request('http://localhost/other'))).status).toBe(200)
    await until(() => listed(root, '/other')?.length === 0)
  })

  it('lists why the server failed to boot, each compile error at its position, and forgets it once a server boots, keeping the requests that threw', async () => {
    await throwingPage(root, 'src/routes/fails.kay')
    const app = await pages({ root, dev: true, prebuilt: false })

    expect((await app.handle(new Request('http://localhost/fails'))).status).toBe(500)

    await Bun.write(join(root, 'src/routes/broken.kay'), 'p ok\nelse\n  p no\n')
    await pages({ root, dev: true, prebuilt: false })
    expect(listed(root, 'boot')).toEqual([{ kind: 'compile', time: expect.any(String), message: '1 compile error', problems: [{ file: 'src/routes/broken.kay', line: 2, column: 1, code: 'template-syntax', message: expect.stringContaining('`else` must directly follow') }], report: expect.stringMatching(/^error\[template-syntax\]: `else` must directly follow[^\n]*\n --> \S*src\/routes\/broken\.kay:2:1\n/) }])
    expect(listed(root, '/fails')).toHaveLength(1)

    rmSync(join(root, 'src/routes/broken.kay'))
    await pages({ root, dev: true, prebuilt: false })
    expect(listed(root, 'boot')).toEqual([])
    expect(listed(root, '/fails')).toHaveLength(1)
  })

  it('lists an error an island met in the browser under its page, the path the app serves it at under a base, until the page is served again', async () => {
    const app = await pages({ root, dev: true, prebuilt: false, base: '/repo' })
    // As the browser sends it: the page's origin and path, under the mount point.
    const report = { name: 'TypeError', message: 'count is undefined', url: 'http://localhost/repo/', island: 'src/components/counter.kay', stack: 'TypeError: count is undefined\n    at click (http://localhost/repo/_kay/counter.js:1:10)' }

    expect((await app.handle(new Request('http://localhost/_kay/error', { method: 'POST', headers: { 'content-type': 'application/json', 'origin': 'http://localhost' }, body: JSON.stringify(report) }))).status).toBe(204)
    expect(listed(root, '/')).toEqual([{ kind: 'browser', time: expect.any(String), request: { method: 'GET', path: '/' }, island: 'src/components/counter.kay', message: 'count is undefined', report: expect.stringContaining('TypeError: count is undefined') }])

    // A stack naming a file no path reads from, as a hostile page could send, is listed as it came, the report still answered and handed to onError.
    const hostile = { ...report, url: 'http://localhost/repo/hostile', stack: 'Error: x\n    at x (file:///%2F:1:1)' }

    expect((await app.handle(new Request('http://localhost/_kay/error', { method: 'POST', headers: { 'content-type': 'application/json', 'origin': 'http://localhost' }, body: JSON.stringify(hostile) }))).status).toBe(204)
    expect(listed(root, '/hostile')).toEqual([expect.objectContaining({ kind: 'browser', report: expect.stringContaining('file:///%2F:1:1') })])

    // A post to the page is no page served again.
    await app.handle(new Request('http://localhost/', { method: 'POST' }))
    expect(listed(root, '/')).toHaveLength(1)
    expect((await app.handle(new Request('http://localhost/'))).status).toBe(200)
    await until(() => listed(root, '/')?.length === 0)
  })

  it('keeps an error met after its response went out fine, as a streamed render\'s, and only the latest 50', async () => {
    const own = await scratchDir('dev-errors-')

    trackDevErrors(own)

    const late = new Request('http://localhost/late')

    recordRequestError(new Error('stream broke'), late)
    answeredWithoutError(late, 200)
    expect(listed(own)).toEqual([expect.objectContaining({ message: 'stream broke' })])

    for (let at = 0; at < 60; at++)
      recordRequestError(new Error(`broke ${at}`), new Request(`http://localhost/${at}`))

    expect(listed(own)!.map(error => error.message)).toEqual(Array.from({ length: 50 }, (_, at) => `broke ${at + 10}`))
  })

  it('keeps the requests a server before it met and forgets why it failed to boot, as a new process', async () => {
    const own = await scratchDir('dev-errors-')
    const file = join(outputDir(own), DEV_ERRORS_FILE)
    const request: DevError = { kind: 'request', time: '2026-01-01T00:00:00.000Z', request: { method: 'POST', path: '/save' }, message: 'save broke', report: 'Error: save broke' }

    await Bun.write(file, JSON.stringify({ errors: [request, { kind: 'boot', time: '2026-01-01T00:00:00.000Z', message: 'down', report: 'Error: down' }] }))
    const run = Bun.spawnSync([process.execPath, '-e', `import { trackDevErrors } from ${JSON.stringify(join(import.meta.dir, '../src/server/dev-errors.ts'))}\ntrackDevErrors(${JSON.stringify(own)})`], { env: { ...process.env, KAY_DEV_CODE: 'test' }, stderr: 'pipe' })

    expect(run.stderr.toString()).toBe('')
    expect(listed(own)).toEqual([request])
  })

  it('lists a kay.config.ts that failed to load, as a new process', async () => {
    const own = await scratchDir('dev-errors-')

    await Bun.write(join(own, 'kay.config.ts'), 'throw new Error(\'config broke\')\n')
    const run = Bun.spawnSync([process.execPath, '-e', `import { pages } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}\nawait pages({ root: ${JSON.stringify(own)}, dev: true }).catch(() => undefined)`], { env: { ...process.env, KAY_DEV_CODE: 'test' }, stderr: 'pipe' })

    expect(run.exitCode).toBe(0)
    expect(listed(own)).toEqual([expect.objectContaining({ kind: 'boot', message: expect.stringContaining('config broke') })])
  })

  it('lists a project that failed to resolve from its config, as a new process', async () => {
    const own = await scratchDir('dev-errors-')

    await Bun.write(join(own, 'kay.config.ts'), 'export default { routes: 1 }\n')
    const run = Bun.spawnSync([process.execPath, '-e', `import { pages } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}\nawait pages({ root: ${JSON.stringify(own)}, dev: true }).catch(() => undefined)`], { env: { ...process.env, KAY_DEV_CODE: 'test' }, stderr: 'pipe' })

    expect(run.exitCode).toBe(0)
    expect(listed(own)).toEqual([expect.objectContaining({ kind: 'boot', message: expect.stringContaining('paths[1]') })])
  })

  it('removes what a server killed mid-write left, and keeps a running one\'s', async () => {
    const own = await scratchDir('dev-errors-')
    const dir = outputDir(own)
    const dead = Bun.spawnSync([process.execPath, '-e', 'process.exit(0)']).pid

    await Bun.write(join(dir, `${DEV_ERRORS_FILE}.${dead}`), '{')
    await Bun.write(join(dir, `${DEV_ERRORS_FILE}.${process.pid}`), '{')
    const run = Bun.spawnSync([process.execPath, '-e', `import { trackDevErrors } from ${JSON.stringify(join(import.meta.dir, '../src/server/dev-errors.ts'))}\ntrackDevErrors(${JSON.stringify(own)})`], { env: { ...process.env, KAY_DEV_CODE: 'test' }, stderr: 'pipe' })

    expect(run.stderr.toString()).toBe('')
    expect(existsSync(join(dir, `${DEV_ERRORS_FILE}.${dead}`))).toBe(false)
    expect(existsSync(join(dir, `${DEV_ERRORS_FILE}.${process.pid}`))).toBe(true)
    expect(listed(own)).toEqual([])
  })

  // Last, as it stops this process tracking errors.
  it('writes nothing for a server run outside kay dev', async () => {
    delete process.env.KAY_DEV_CODE

    try {
      await throwingPage(root, 'src/routes/outside.kay')
      const app = await pages({ root, dev: true, prebuilt: false })

      expect((await app.handle(new Request('http://localhost/outside'))).status).toBe(500)
      await Bun.sleep(50)
      expect(listed(root)).toBeUndefined()
    }
    finally {
      process.env.KAY_DEV_CODE = 'test'
    }
  })
})

describe('kay dev --format json', () => {
  it('prints each event as one JSON object on stdout, the errors the server meets included, the server\'s own output going to stderr', async () => {
    const project = await scratchDir('dev-errors-')

    await throwingPage(project, 'src/routes/index.kay')
    // Read by the process building the client as by the server, whose output goes to stderr alike.
    await Bun.write(join(project, 'kay.config.ts'), 'console.log(\'config read\')\nexport default {}\n')
    const port = freePort()

    const child = Bun.spawn([process.execPath, CLI, 'dev', project, '--port', String(port), '--format', 'json'], { stdout: 'pipe', stderr: 'pipe' })
    const lines: string[] = []
    let errors = ''
    const reading = (async () => {
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream()))
        lines.push(...chunk.split('\n').filter(Boolean))
    })()
    const readingErrors = (async () => {
      for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream()))
        errors += chunk
    })()

    try {
      await until(() => lines.length > 0, 20_000)
      expect(JSON.parse(lines[0]!)).toEqual({ event: 'ready', time: expect.any(String), url: `http://localhost:${port}`, ms: expect.any(Number) })

      expect((await fetch(`http://localhost:${port}/`)).status).toBe(500)
      await until(() => lines.length > 1, 10_000)
      expect(JSON.parse(lines[1]!)).toEqual(expect.objectContaining({ event: 'error', kind: 'request', request: { method: 'GET', path: '/' }, message: 'load broke' }))
      await until(() => errors.includes('Error: load broke') && errors.includes('config read'))

      for (const line of lines)
        expect(() => JSON.parse(line) as unknown).not.toThrow()
    }
    finally {
      child.kill()
      await child.exited
      await Promise.all([reading, readingErrors])
    }
  }, 40_000)

  it('points console.log back at stdout once it returns, run in-process', async () => {
    const project = await scratchDir('dev-errors-')
    const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } })
    const log = console.log
    const said = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      expect(await runCommand(devCommand, [project, '--format', 'json', `--inspect=127.0.0.1:${held.port}`], 'usage')).toBe(1)
      expect(said).toHaveBeenCalledWith(expect.stringContaining('in use'))
      expect(console.log).toBe(log)
    }
    finally {
      said.mockRestore()
      held.stop(true)
    }
  })

  it('leaves no signal listener behind after a quit or a refused start, run in-process', async () => {
    const project = await scratchDir('dev-errors-')
    const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } })
    const signals = () => [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]
    const before = signals()
    const said = spyOn(console, 'error').mockImplementation(() => undefined)

    await Bun.write(join(project, 'src/routes/index.kay'), 'p Home\n')

    try {
      expect(await runCommand(devCommand, [project, '--format', 'json', `--inspect=127.0.0.1:${held.port}`], 'usage')).toBe(1)
      expect(signals()).toEqual(before)

      const running = runCommand(devCommand, [project, '--port', '0', '--format', 'json'], 'usage')

      await until(() => process.listenerCount('SIGTERM') > before[1]!, 20_000)
      process.emit('SIGTERM')
      expect(await running).toBe(0)
      expect(signals()).toEqual(before)
    }
    finally {
      said.mockRestore()
      held.stop(true)
    }
  }, 40_000)

  it('refuses another format', async () => {
    const child = Bun.spawn([process.execPath, CLI, 'dev', '--format', 'yaml'], { stdout: 'ignore', stderr: 'pipe' })

    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toStartWith('kay: --format takes `text` or `json`, not `yaml`\n')
  })
})
