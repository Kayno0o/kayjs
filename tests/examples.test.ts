import type { Subprocess } from 'bun'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { check } from '../src/check'
import { loadConfig } from '../src/config'

const CLI = join(import.meta.dir, '../src/cli.ts')
const APP = join(import.meta.dir, '../examples/noticeboard')
const LISTENING = /localhost:(\d+)/
const SOME_PASSED = / [1-9]\d* pass/
// A Postgres whose user may create databases, as the app template's tests take: CI sets it.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const SECRETS = { SESSION_SECRET: 'only-for-tests-0123456789abcdefghijklmnop', AUTH_SECRET: 'only-for-tests-too-abcdefghijklmnop0123456789' }

// The example runs kay from this checkout with kayjs-auth, kayjs-mail and kayjs-ui as the root installs them, so a change on either side that breaks the other fails here before it reaches a site.
describe('the noticeboard example', () => {
  it('passes kay check, the libraries\' components typed from the node_modules above it', async () => {
    expect(await check(APP, await loadConfig(APP))).toEqual([])
  }, 60_000)

  // Signs in, mails links, pins notices over the rooms, runs the queue and drives the islands in a browser, each test file on a database of its own.
  it.skipIf((TEST_DATABASE_URL ?? '') === '' && (process.env.CI ?? '') === '')('passes its own tests', async () => {
    if (TEST_DATABASE_URL === undefined || TEST_DATABASE_URL === '')
      throw new Error('set TEST_DATABASE_URL to a Postgres whose user may create databases')

    const database = new URL(TEST_DATABASE_URL)

    database.pathname = '/noticeboard_test'

    const tests = Bun.spawn([process.execPath, 'test', '--isolate'], { cwd: APP, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, DATABASE_URL: database.href } })
    const [report, code] = await Promise.all([new Response(tests.stderr).text(), tests.exited])

    // Thrown rather than asserted, so the report prints line by line instead of escaped into one string.
    if (code !== 0 || !SOME_PASSED.test(report))
      throw new Error(`the example's own tests failed:\n${report}`)
  }, 120_000)

  it('compiles to one executable serving its pages with the libraries\' components and styles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-noticeboard-'))

    try {
      const build = Bun.spawn([process.execPath, CLI, 'build', '--compile', join(dir, 'server')], { cwd: APP, stdout: 'pipe', stderr: 'pipe' })
      const [report, errors, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited])

      if (code !== 0 || !report.includes('compiled '))
        throw new Error(`kay build --compile failed:\n${report}${errors}`)

      // Nothing reaches the database or a mail server until a page asks: the page a magic link opens needs neither, where the sign-in page reads the client's attempts for its proof of work.
      const server = Bun.spawn([join(dir, 'server')], { cwd: dir, env: { PATH: process.env.PATH, PORT: '0', ...SECRETS, DATABASE_URL: 'postgres://app:app@127.0.0.1:1/none', SMTP_HOST: 'localhost' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

      try {
        const origin = `http://localhost:${await listeningPort(server)}`
        const magic = await (await fetch(`${origin}/auth/magic-link?token=mailed`)).text()
        const stylesheet = (/<link rel="stylesheet" href="(\/_kay\/[^"]+\.css)"/).exec(magic)![1]!

        expect(magic).toContain('<title>Sign in | Noticeboard</title>')
        expect(magic).toContain('class="kui-btn')
        expect(await (await fetch(`${origin}${stylesheet}`)).text()).toContain('.kui-btn')
        expect(await Bun.spawn([join(dir, 'server'), '--health'], { cwd: dir, env: { PATH: process.env.PATH, PORT: new URL(origin).port }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exited).toBe(0)
      }
      finally {
        server.kill()
        await server.exited
      }
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

// The port the server prints once it listens.
async function listeningPort(child: Subprocess<'ignore', 'pipe', 'pipe'>): Promise<string> {
  const reader = child.stdout.getReader()
  let output = ''

  for (let match = LISTENING.exec(output); !match; match = LISTENING.exec(output)) {
    const { value, done } = await reader.read()

    if (done)
      throw new Error(`the executable exited without listening: ${await new Response(child.stderr).text()}`)

    output += new TextDecoder().decode(value)
  }

  reader.releaseLock()

  return LISTENING.exec(output)![1]!
}
