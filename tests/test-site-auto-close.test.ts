import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it, mock } from 'bun:test'
import { browserPath } from '../src/test'
import { closeAfterTests, closeSites } from '../src/test/sites'
import { fixtureCopy, scratchDir } from './scratch'

const PRELOAD = join(import.meta.dir, '..', 'src', 'test', 'preload.ts')
const SRC = resolve(import.meta.dir, '..', 'src')
const fixture = resolve(await fixtureCopy('live'))

// The preload listed after kay's reports, once the file's tests ran, the state of the connections the file left open.
const REPORT = `import { afterAll } from 'bun:test'
afterAll(async () => { console.log('STATES ' + JSON.stringify(await (globalThis as { states?: () => unknown }).states?.())) })
`

// A test file that opens a socket and a stream on its site and never closes it, the site made at the top of the file, in a hook or in a test.
function leaking(where: 'top' | 'beforeAll' | 'test', ending = ''): string {
  const body = `const site = await testSite({ api: ${JSON.stringify(join(fixture, 'src/api'))}, islands: false })
  const room = site.socket(chat, '/:room', { params: { room: 'left' } })
  const ticks = site.stream(chat, '/forever')

  room.send({ text: 'hi' })
  await room.next()
  await ticks.next()
  ;(globalThis as { states?: () => unknown }).states = () => [room.status(), ticks.status()]
  ${ending}`

  const wrapped = { top: body, beforeAll: `beforeAll(async () => {\n${body}\n})\nit('passes', () => {})`, test: `it('opens', async () => {\n${body}\n})` }[where]

  return `import { beforeAll, it } from 'bun:test'
import { testSite } from ${JSON.stringify(join(SRC, 'test'))}
import chat from ${JSON.stringify(join(fixture, 'src/api/chat.ts'))}

${wrapped}
`
}

// A test file that opens a page of a browser site and never closes it; once the site is closed, a call on the page fails.
function browsing(navigation: string): string {
  return `import { it } from 'bun:test'
import { testSite } from ${JSON.stringify(join(SRC, 'test'))}

const site = await testSite({ routes: ${JSON.stringify(join(navigation, 'src/routes'))}, browser: { path: ${JSON.stringify(browserPath())} }, onError: () => undefined })
const page = await site.open('/')

;(globalThis as { states?: () => unknown }).states = async () => {
  try {
    await page.text('body')

    return ['open']
  }
  catch {
    return ['closed']
  }
}
it('passes', () => {})
`
}

async function run(where: 'top' | 'beforeAll' | 'test' | 'browser', args: string[], ending = ''): Promise<{ code: number, report: string }> {
  const dir = await scratchDir('auto-close-')
  const root = where === 'browser' ? resolve(await fixtureCopy('navigation')) : fixture

  await Bun.write(join(dir, 'bunfig.toml'), `[test]\npreload = [${JSON.stringify(PRELOAD)}, "./report.ts"]\n`)
  await Bun.write(join(dir, 'report.ts'), REPORT)
  await Bun.write(join(dir, 'leak.test.ts'), where === 'browser' ? browsing(root) : leaking(where, ending))
  await Bun.write(join(dir, 'other.test.ts'), `import { it } from 'bun:test'\nit('runs after', () => {})\n`)

  const child = Bun.spawn([process.execPath, 'test', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, KAY_ROOT: root } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, report: out + err }
}

describe('a test site left open by its file', () => {
  for (const where of ['top', 'beforeAll', 'test'] as const) {
    for (const args of [[], ['--isolate']]) {
      it(`is closed after the tests, made ${where === 'top' ? 'at the top of the file' : `in ${where === 'test' ? 'a test' : 'beforeAll'}`}${args.length > 0 ? ' with --isolate' : ''}`, async () => {
        const { code, report } = await run(where, args)

        expect(report).toContain('STATES ["closed","closed"]')
        expect(code).toBe(0)
      }, 60_000)
    }
  }
})

describe('a test site closed by hand', () => {
  it('leaves the registry, so a run keeps nothing of it until the end', async () => {
    const closed = mock(async () => undefined)
    const left = mock(async () => undefined)

    closeAfterTests(closed)()
    closeAfterTests(left)
    await closeSites()

    expect(closed).not.toHaveBeenCalled()
    expect(left).toHaveBeenCalledTimes(1)
  })

  for (const args of [[], ['--isolate'], ['--parallel']]) {
    it(`can be closed twice with a listening server${args.length > 0 ? ` (${args[0]})` : ''}`, async () => {
      const { code, report } = await run('top', args, 'await site.close()\n  await site.close()')

      expect(report).toContain('STATES ["closed","closed"]')
      expect(code).toBe(0)
    }, 60_000)
  }
})

describe.skipIf(browserPath() === undefined && (process.env.CI ?? '') === '')('a browser site left open', () => {
  for (const args of [[], ['--isolate'], ['--parallel']]) {
    it(`has its pages closed after the tests${args.length > 0 ? ` (${args[0]})` : ''}`, async () => {
      const { code, report } = await run('browser', args)

      expect(report).toContain('STATES ["closed"]')
      expect(code).toBe(0)
    }, 60_000)
  }
})

describe('a test site left open with --parallel', () => {
  it('is closed after the tests', async () => {
    const { code, report } = await run('test', ['--parallel'])

    expect(report).toContain('STATES ["closed","closed"]')
    expect(code).toBe(0)
  }, 60_000)
})
