// #3665: `kay dev` serves the app from a child process behind a parent that keeps the port and the browsers' reload stream.

import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { devSupervisor } from '../src/dev/supervisor'

const tempDirs: string[] = []
afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

// An app whose `/` prints the config's site and the app process's pid, and whose `/echo` answers what it received.
function makeApp(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'kay-dev-process-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(import.meta.dir, '..'), join(dir, 'node_modules/@kayjs/kay'), 'dir')
  const all: Record<string, string> = {
    'lib/site.ts': `export const siteName = 'one'\n`,
    'kay.config.ts': `import { defineConfig } from '@kayjs/kay/config'\nimport { siteName } from './lib/site'\nexport default defineConfig({ site: \`https://\${siteName}.test\` })\n`,
    'src/routes/index.tsx': `import { siteName } from '../../lib/site'\nexport default function Home() { return <p>{siteName} {process.pid}</p> }\n`,
    'src/routes/echo.ts': `export async function POST(ctx) { return new Response(\`\${ctx.ip} \${ctx.url.host} \${await ctx.request.text()}\`) }\nexport function GET(ctx) { return ctx.redirect('/') }\n`,
    ...files,
  }
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

const home = async (url: string): Promise<{ site: string, pid: string }> => {
  const [, site, pid] = /<p>(\w+) (\d+)<\/p>/.exec(await (await fetch(url)).text())!
  return { site: site!, pid: pid! }
}

async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let buf = ''
  const timeout = AbortSignal.timeout(10_000)
  while (!timeout.aborted) {
    const { value, done } = await reader.read()
    if (done)
      throw new Error(`the reload stream closed after ${JSON.stringify(buf)}`)
    buf += decoder.decode(value)
    const m = /data: ([^\n]+)\n\n/.exec(buf)
    if (m !== null)
      return m[1]!
  }
  throw new Error(`no reload event after ${JSON.stringify(buf)}`)
}

// Waits until `/` is answered by an app process other than `pid`.
async function nextProcess(url: string, pid: string): Promise<{ site: string, pid: string }> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const now = await home(url)
    if (now.pid !== pid)
      return now
    await Bun.sleep(50)
  }
  throw new Error('the app process was not replaced')
}

describe('#3665 kay dev runs the app in a child process', () => {
  it('passes the request body, the client address and the Host to the app, its redirects to the browser, and refuses a foreign origin', async () => {
    const dev = await devSupervisor({ root: makeApp(), port: 0 })
    try {
      const { pid } = await home(dev.url)
      expect(pid).not.toBe(String(process.pid))
      const host = new URL(dev.url).host
      const echo = await fetch(`${dev.url}/echo`, { method: 'POST', headers: { 'origin': dev.url, 'x-kay-dev-client-ip': '6.6.6.6' }, body: 'hello' })
      expect(await echo.text()).toBe(`127.0.0.1 ${host} hello`)
      const redirect = await fetch(`${dev.url}/echo`, { redirect: 'manual' })
      expect([redirect.status, redirect.headers.get('location')]).toEqual([302, '/'])
      expect((await fetch(`${dev.url}/echo`, { method: 'POST', headers: { origin: 'https://evil.test' }, body: 'x' })).status).toBe(403)
    }
    finally {
      await dev.stop()
    }
  })

  it('starts a new app process when a file kay.config.ts imports changes, the reload stream staying open', async () => {
    const dir = makeApp()
    const dev = await devSupervisor({ root: dir, port: 0 })
    const ac = new AbortController()
    try {
      const before = await home(dev.url)
      expect(before.site).toBe('one')
      const reader = (await fetch(`${dev.url}/_kay/dev-events`, { signal: ac.signal })).body!.getReader()
      await Bun.sleep(60)
      writeFileSync(join(dir, 'lib/site.ts'), `export const siteName = 'two'\n`)
      expect(await nextEvent(reader)).toBe('reload')
      const after = await home(dev.url)
      expect(after.site).toBe('two')
      expect(after.pid).not.toBe(before.pid)
      expect(() => process.kill(Number(before.pid), 0)).toThrow()
    }
    finally {
      ac.abort()
      await dev.stop()
    }
  })

  it('replaces an app process that passed its memory limit after a rebuild', async () => {
    const dir = makeApp()
    const dev = await devSupervisor({ root: dir, port: 0, maxRssMb: 1 })
    try {
      const before = await home(dev.url)
      writeFileSync(join(dir, 'src/routes/other.tsx'), `export default function Other() { return <p>other</p> }\n`)
      const after = await nextProcess(dev.url, before.pid)
      expect(after.site).toBe('one')
      // A fresh process is not measured until it rebuilds: it keeps answering.
      await Bun.sleep(300)
      expect((await home(dev.url)).pid).toBe(after.pid)
    }
    finally {
      await dev.stop()
    }
  })

  it('reports a crashed app process in the page with its error, and starts it again on the next save', async () => {
    const dir = makeApp({ 'src/routes/die.ts': `export function POST() { setTimeout(() => { throw new Error('the app blew up') }); return new Response('bye') }\nexport const csrf = false\n` })
    const dev = await devSupervisor({ root: dir, port: 0 })
    try {
      const before = await home(dev.url)
      await fetch(`${dev.url}/die`, { method: 'POST' })
      let crash: Response
      do
        crash = await fetch(dev.url, { headers: { accept: 'text/plain' } })
      while (crash.status === 200)
      expect(crash.status).toBe(500)
      const text = await crash.text()
      expect(text).toStartWith('kay dev: the app process exited with code 1.')
      expect(text).toContain('the app blew up')
      writeFileSync(join(dir, 'src/routes/other.tsx'), `export default function Other() { return <p>other</p> }\n`)
      expect((await nextProcess(dev.url, before.pid)).site).toBe('one')
    }
    finally {
      await dev.stop()
    }
  })

  async function startCli(dir: string): Promise<{ cli: Bun.Subprocess<'ignore', 'pipe', 'inherit'>, url: string }> {
    const cli = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli/index.ts'), 'dev', '--port', '0'], { cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
    let out = ''
    const decoder = new TextDecoder()
    for await (const chunk of cli.stdout) {
      out += decoder.decode(chunk)
      if (out.includes('listening on http'))
        break
    }
    return { cli, url: /listening on (http\S+)/.exec(out)![1]! }
  }

  it('stops its app process on SIGTERM from the CLI, leaving no .kay-dev behind', async () => {
    const dir = makeApp()
    const { cli, url } = await startCli(dir)
    const { pid } = await home(url)
    expect(existsSync(join(dir, '.kay-dev'))).toBe(true)
    cli.kill('SIGTERM')
    expect(await cli.exited).toBe(0)
    expect(() => process.kill(Number(pid), 0)).toThrow()
    expect(existsSync(join(dir, '.kay-dev'))).toBe(false)
  })

  it('has its app process stop on its own when the CLI is killed', async () => {
    const dir = makeApp()
    const { cli, url } = await startCli(dir)
    const { pid } = await home(url)
    cli.kill('SIGKILL')
    await cli.exited
    const deadline = Date.now() + 10_000
    while (existsSync(join(dir, '.kay-dev')) && Date.now() < deadline)
      await Bun.sleep(50)
    expect(existsSync(join(dir, '.kay-dev'))).toBe(false)
    expect(() => process.kill(Number(pid), 0)).toThrow()
  })
})
