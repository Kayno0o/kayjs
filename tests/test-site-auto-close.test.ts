import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { fixtureCopy, scratchDir } from './scratch'

const PRELOAD = join(import.meta.dir, '..', 'src', 'test', 'preload.ts')
const SRC = resolve(import.meta.dir, '..', 'src')
const fixture = resolve(await fixtureCopy('live'))

// The preload listed after kay's reports, once the file's tests ran, the state of the connections the file left open.
const REPORT = `import { afterAll } from 'bun:test'
afterAll(() => { console.log('STATES ' + JSON.stringify((globalThis as { states?: () => unknown }).states?.())) })
`

// A test file that opens a socket and a stream on its site and never closes it, the site made at the top of the file, in a hook or in a test.
function leaking(where: 'top' | 'beforeAll' | 'test'): string {
  const body = `const site = await testSite({ api: ${JSON.stringify(join(fixture, 'src/api'))}, islands: false })
  const room = site.socket(chat, '/:room', { params: { room: 'left' } })
  const ticks = site.stream(chat, '/forever')

  room.send({ text: 'hi' })
  await room.next()
  await ticks.next()
  ;(globalThis as { states?: () => unknown }).states = () => [room.status(), ticks.status()]`

  const wrapped = { top: body, beforeAll: `beforeAll(async () => {\n${body}\n})\nit('passes', () => {})`, test: `it('opens', async () => {\n${body}\n})` }[where]

  return `import { beforeAll, it } from 'bun:test'
import { testSite } from ${JSON.stringify(join(SRC, 'test'))}
import chat from ${JSON.stringify(join(fixture, 'src/api/chat.ts'))}

${wrapped}
`
}

async function run(where: 'top' | 'beforeAll' | 'test', args: string[]): Promise<{ code: number, report: string }> {
  const dir = await scratchDir('auto-close-')

  await Bun.write(join(dir, 'bunfig.toml'), `[test]\npreload = [${JSON.stringify(PRELOAD)}, "./report.ts"]\n`)
  await Bun.write(join(dir, 'report.ts'), REPORT)
  await Bun.write(join(dir, 'leak.test.ts'), leaking(where))
  await Bun.write(join(dir, 'other.test.ts'), `import { it } from 'bun:test'\nit('runs after', () => {})\n`)

  const child = Bun.spawn([process.execPath, 'test', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, KAY_ROOT: fixture } })
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
