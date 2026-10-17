import { existsSync, readdirSync, rmSync, symlinkSync, utimesSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { dev } from '../src/dev'
import { devAddressFile, readDevAddress, removeDevAddress, writeDevAddress } from '../src/dev/address'
import { mountedAt } from '../src/dev/base-proxy'
import { keep, MAX_FILES, pagePath, prune, screenshot, SCREENSHOTS_DIR, shotName } from '../src/dev/screenshot'
import { diffPngs } from '../src/dev/screenshot-diff'
import { McpServer } from '../src/mcp/protocol'
import { projectCapabilities } from '../src/mcp/tools'
import { encodePng } from '../src/server/png'
import { browserPath } from '../src/test'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')
const PNG = [137, 80, 78, 71]
const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
// CI installs Chromium for these: there, a missing browser fails rather than skips.
const skipBrowser = browserPath() === undefined && (process.env.CI ?? '') === ''

async function run(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number, stdout: string, stderr: string }> {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])

  return { code: await child.exited, stdout, stderr }
}

function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } })
  const { port } = probe

  probe.stop(true)

  return port
}

// A square image of one colour, with a rectangle of another.
function image(width: number, height: number, block?: { x: number, y: number, width: number, height: number }): Uint8Array {
  const pixels = new Uint8Array(width * height * 4).fill(255)

  if (block) {
    for (let y = block.y; y < block.y + block.height; y++) {
      for (let x = block.x; x < block.x + block.width; x++)
        pixels.set([0, 0, 255, 255], (y * width + x) * 4)
    }
  }

  return encodePng(pixels, width, height)
}

function BOX_CSS(width: number, color: string) {
  return `body { margin: 0; background: #fff }
@media (prefers-color-scheme: dark) { body { background: #000 } }
.box { width: ${width}px; height: 50px; background: ${color} }
`
}

describe('the page a screenshot is asked for', () => {
  it('is a path of the dev server, under the site\'s base', () => {
    expect(pagePath('/about')).toBe('/about')
    expect(pagePath('/search?q=a/../b#top')).toBe('/search?q=a/../b#top')
    expect(pagePath('/about', '/app')).toBe('/app/about')
    expect(pagePath('/', '/app')).toBe('/app/')
    expect(pagePath('/app/about', '/app')).toBe('/app/about')
    expect(pagePath('/app', '/app')).toBe('/app')
    expect(pagePath('/application', '/app')).toBe('/app/application')
    expect(pagePath('/fr/about', '/app')).toBe('/app/fr/about')
  })

  it.each([
    ['without a slash', 'about'],
    ['a full URL to another host', 'https://evil.example/about'],
    ['a protocol-relative URL', '//evil.example/about'],
    ['a backslash the URL parser reads as a slash', '/\\evil.example'],
    ['a dot-dot segment', '/a/../b'],
    ['an encoded dot-dot segment', '/a/%2e%2E/b'],
    ['a trailing dot-dot', '/a/..'],
    ['a control character', '/a\nb'],
    ['a malformed escape', '/%zz'],
    ['nothing', ''],
    ['a second slash after the base', '/app//evil.example/x'],
    ['a backslash after the base', '/app/\\evil.example'],
  ])('refuses %s', (_name, path) => {
    expect(() => pagePath(path, '/app')).toThrow()
  })
})

describe('the proxy that mounts the site', () => {
  it('forwards a path under the base to the dev server alone, never to another host', async () => {
    const seen: string[] = []
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => {
      seen.push(new URL(request.url).pathname)

      return new Response('ok')
    } })
    const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('other host') })
    const proxy = mountedAt(`http://127.0.0.1:${upstream.port}`, '/app')

    try {
      const get = async (path: string) => fetch(`${proxy.origin}${path}`)

      expect(await (await get('/app/about')).text()).toBe('ok')
      expect(seen).toEqual(['/about'])
      expect((await get('/app')).status).toBe(200)
      expect(seen.at(-1)).toBe('/')
      // The dev tool asks for its own files without the base.
      expect((await get('/_kay/dev/axe.js')).status).toBe(200)
      expect(seen.at(-1)).toBe('/_kay/dev/axe.js')
      expect((await get(`/app//127.0.0.1:${other.port}/x`)).status).toBe(400)
      expect((await fetch(`${proxy.origin}/app/about`, { headers: { host: 'evil.example' } })).status).toBe(400)
      expect(seen).not.toContain(`//127.0.0.1:${other.port}/x`)
    }
    finally {
      proxy.stop()
      void upstream.stop(true)
      void other.stop(true)
    }
  })
})

describe('the file a shot is kept in', () => {
  it('never shares a name between two paths, sizes or schemes, nor leaves the folder', () => {
    const names = [shotName('/a-b', 375, 'light', undefined, false), shotName('/a/b', 375, 'light', undefined, false), shotName('/a_2Fb', 375, 'light', undefined, false), shotName('/a/b', 1280, 'light', undefined, false), shotName('/a/b', 375, 'dark', undefined, false), shotName('/a/b', 375, 'light', 600, false), shotName('/a/b', 375, 'light', undefined, true), shotName('/', 375, 'light', undefined, false), shotName('/index', 375, 'light', undefined, false), shotName('/About', 375, 'light', undefined, false), shotName('/about', 375, 'light', undefined, false)]

    expect(new Set(names).size).toBe(names.length)
    expect(names.every(name => !(/[/\\]/).test(name))).toBe(true)
    expect(shotName('/', 375, 'light', undefined, false)).toBe('_root.375.light')
    expect(shotName(`/${'x'.repeat(5000)}`, 375, 'light', undefined, false).length).toBeLessThan(140)
    expect(shotName(`/${'x'.repeat(5000)}a`, 375, 'light', undefined, false)).not.toBe(shotName(`/${'x'.repeat(5000)}b`, 375, 'light', undefined, false))
  })

  it('keeps a bounded number of files, the oldest going first', async () => {
    const dir = await scratchDir('shots-')

    try {
      for (let index = 0; index < MAX_FILES + 10; index++) {
        const file = join(dir, `${index}.png`)

        await Bun.write(file, 'x')
        utimesSync(file, 1000 + index, 1000 + index)
      }

      prune(dir)

      const left = readdirSync(dir)

      expect(left).toHaveLength(MAX_FILES)
      expect(left).toContain(`${MAX_FILES + 9}.png`)
      expect(left).not.toContain('0.png')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the diff of two shots', () => {
  it('finds nothing in the same image', async () => {
    const same = await diffPngs(image(40, 30), image(40, 30))

    expect(same).toMatchObject({ changed: 0, ratio: 0, box: undefined })
  })

  it('marks the pixels that changed and the rectangle holding them, in an image of the same size', async () => {
    const diff = await diffPngs(image(40, 30), image(40, 30, { x: 5, y: 10, width: 8, height: 4 }))

    expect(diff.changed).toBe(32)
    expect(diff.box).toEqual({ x: 5, y: 10, width: 8, height: 4 })
    expect([...diff.image.subarray(0, 4)]).toEqual(PNG)
  })

  it('compares images of two sizes on the larger canvas, what only one holds being changed', async () => {
    const diff = await diffPngs(image(40, 30), image(40, 50))

    expect(diff.changed).toBe(40 * 20)
    expect(diff.box).toEqual({ x: 0, y: 30, width: 40, height: 20 })
    expect(diff.ratio).toBeCloseTo(0.4)
  })
})

describe('prune with a file that vanishes', () => {
  it('goes on past a file it cannot read, and leaves a lock alone', async () => {
    const dir = await scratchDir('shots-vanish-')

    try {
      for (let index = 0; index < MAX_FILES + 5; index++) {
        const file = join(dir, `${index}.png`)

        await Bun.write(file, 'x')
        utimesSync(file, 1000 + index, 1000 + index)
      }

      symlinkSync(join(dir, 'missing.png'), join(dir, 'dangling.link'))
      await Bun.write(join(dir, 'page.lock'), '1')
      prune(dir)

      const left = readdirSync(dir)

      expect(left).toContain('page.lock')
      expect(left).not.toContain('0.png')
      expect(left.filter(name => name.endsWith('.png'))).toHaveLength(MAX_FILES)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs after a shot that failed', async () => {
    const root = await scratchDir('shots-failed-')
    const dir = join(root, SCREENSHOTS_DIR)

    try {
      await mkdir(dir, { recursive: true })

      for (let index = 0; index < MAX_FILES + 5; index++) {
        const file = join(dir, `${index}.png`)

        await Bun.write(file, 'x')
        utimesSync(file, 1000 + index, 1000 + index)
      }

      writeDevAddress(root, 'http://localhost:1')

      await expect(screenshot(root, '/')).rejects.toThrow()
      expect(readdirSync(dir)).toHaveLength(MAX_FILES)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('keeping a shot', () => {
  it('makes no diff beyond the pixels it caps, and none leaves a lock behind when two shoot one page', async () => {
    const root = await scratchDir('shots-keep-')
    const big = image(3500, 3500)

    try {
      await keep(root, 'big', big, { width: 3500, scheme: 'light', cut: false })

      const again = await keep(root, 'big', big, { width: 3500, scheme: 'light', cut: false })

      expect(again.diff).toBeUndefined()
      expect(again.diffSkipped).toBe(true)

      const small = image(40, 40)
      const both = await Promise.all([keep(root, 'small', small, { width: 40, scheme: 'light', cut: false }), keep(root, 'small', image(40, 40, { x: 0, y: 0, width: 5, height: 5 }), { width: 40, scheme: 'light', cut: false })])

      expect(both.every(shot => shot.size.width === 40)).toBe(true)
      expect(readdirSync(join(root, SCREENSHOTS_DIR)).filter(name => name.endsWith('.lock'))).toEqual([])
      expect(existsSync(join(root, SCREENSHOTS_DIR, 'small.png'))).toBe(true)
      expect(existsSync(join(root, SCREENSHOTS_DIR, 'small.prev.png'))).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('the address of the dev server', () => {
  it('is read while the process that wrote it lives, and only for that process removed', async () => {
    const root = await scratchDir('address-')

    try {
      expect(readDevAddress(root)).toBeUndefined()

      writeDevAddress(root, 'http://localhost:3000')

      expect(readDevAddress(root)).toBe('http://localhost:3000')

      await Bun.write(devAddressFile(root, 2 ** 22 + 1), JSON.stringify({ url: 'http://localhost:3001', pid: 2 ** 22 + 1 }))
      removeDevAddress(root)

      expect(readDevAddress(root)).toBeUndefined()
      expect(existsSync(devAddressFile(root, 2 ** 22 + 1))).toBe(false)

      await Bun.write(devAddressFile(root), JSON.stringify({ url: 'ftp://localhost', pid: process.pid }))

      expect(readDevAddress(root)).toBeUndefined()

      await Bun.write(devAddressFile(root), 'not json')

      expect(readDevAddress(root)).toBeUndefined()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps one file per process, so the first of two to exit leaves the other\'s address', async () => {
    const root = await scratchDir('address-two-')
    const other = Bun.spawn(['sleep', '60'])

    try {
      await Bun.write(devAddressFile(root, other.pid), JSON.stringify({ url: 'http://localhost:3001', pid: other.pid }))
      await Bun.sleep(20)
      writeDevAddress(root, 'http://localhost:3000')

      expect(readDevAddress(root)).toBe('http://localhost:3000')

      removeDevAddress(root)

      expect(readDevAddress(root)).toBe('http://localhost:3001')
      expect(existsSync(devAddressFile(root, other.pid))).toBe(true)
    }
    finally {
      other.kill()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('kay screenshot refusing before any browser starts', () => {
  let root: string

  beforeAll(async () => {
    root = await scratchDir('shot-refused-')
    await Bun.write(join(root, 'tsconfig.json'), tsconfig)
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Hi\n')
  })

  afterAll(async () => rm(root, { recursive: true, force: true }))

  // A browser that cannot start tells a refusal that came after it from one that came before.
  const noBrowser = { BUN_CHROME_PATH: '/nonexistent/chrome' }

  it('says no dev server runs when none does', async () => {
    const { code, stderr } = await run(root, ['screenshot', '/'], noBrowser)

    expect(code).toBe(1)
    expect(stderr).toContain('no `kay dev` is running')
  })

  it('says so for an address a dead process left', async () => {
    await Bun.write(devAddressFile(root, 2 ** 22 + 1), JSON.stringify({ url: 'http://localhost:1', pid: 2 ** 22 + 1 }))

    const { code, stderr } = await run(root, ['screenshot', '/'], noBrowser)

    expect(code).toBe(1)
    expect(stderr).toContain('no `kay dev` is running')
  })

  it('names BUN_CHROME_PATH when there is no Chrome', async () => {
    writeDevAddress(root, 'http://localhost:1')

    const { code, stderr } = await run(root, ['screenshot', '/'], noBrowser)

    expect(code).toBe(1)
    expect(stderr).toContain('BUN_CHROME_PATH')
  })

  it.each(['about', 'https://evil.example/', '//evil.example', '/\\evil.example', '/a/../b', '/a/%2e%2e/b'])('refuses the page %s with a dev server running', async (path) => {
    writeDevAddress(root, 'http://localhost:1')

    const { code, stderr } = await run(root, ['screenshot', path], noBrowser)

    expect(code).toBe(1)
    expect(stderr).not.toContain('BUN_CHROME_PATH')
    expect(stderr).toContain('screenshot')
  })

  it.each([['--width', '100'], ['--width', '9999'], ['--height', '99999'], ['--width', 'wide'], ['--scheme', 'sepia']])('refuses %s %s', async (flag, value) => {
    writeDevAddress(root, 'http://localhost:1')

    const { code, stderr } = await run(root, ['screenshot', '/', flag, value], noBrowser)

    expect(code).toBe(1)
    expect(stderr).not.toContain('BUN_CHROME_PATH')
  })

  it('is refused by the MCP tool the same way, the arguments checked first', async () => {
    const { tools, resources } = await projectCapabilities(root)
    const server = new McpServer(tools, resources, () => undefined)
    const call = async (args: object) => {
      const reply = await server.answer(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screenshot', arguments: args } }))

      return (reply as { result: { isError?: boolean, content: { text: string }[] } }).result
    }

    for (const args of [{ path: 'about' }, { path: '--help' }, { path: '/', width: '375' }, { path: '/', scheme: 'sepia' }, { path: '//evil.example' }, { path: '/a/../b' }])
      expect((await call(args)).isError).toBe(true)

    writeDevAddress(root, 'http://localhost:1')
    rmSync(devAddressFile(root))

    const none = await call({ path: '/' })

    expect(none.isError).toBe(true)
    expect(none.content[0]!.text).toContain('no `kay dev` is running')
  })
})

describe.skipIf(skipBrowser)('kay screenshot on a running kay dev', () => {
  let root: string
  let stop: () => Promise<void>

  const route = async (name: string, source: string) => Bun.write(join(root, 'src/routes', name), source)
  const shot = async (path: string, options: Parameters<typeof screenshot>[2] = {}) => screenshot(root, path, { base: '/app', ...options })
  const file = (relative: string) => Bun.file(join(root, relative))

  beforeAll(async () => {
    root = await scratchDir('shot-')
    await mkdir(join(root, 'src/messages'), { recursive: true })
    await Bun.write(join(root, 'tsconfig.json'), tsconfig)
    await Bun.write(join(root, 'kay.config.ts'), 'export default { base: \'/app\', trailingSlash: \'always\', i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\' } }\n')
    await Bun.write(join(root, 'src/messages/en.ts'), 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ title: \'Hello\' })\n')
    await Bun.write(join(root, 'src/messages/fr.ts'), 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ title: \'Bonjour\' })\n')
    await route('about.kay', '--- server\nimport { t } from \'kay/i18n\'\n---\nh1 {t(\'title\')}\n')
    await route('index.kay', 'h1 Home\n')
    await route('box.kay', '--- script\nimport \'./box.css\'\n---\ndiv.box\n')
    await Bun.write(join(root, 'src/routes/box.css'), BOX_CSS(100, '#c00'))
    await route('who.kay', '--- server\nconst who = ctx.cookies.get(\'session\') ?? \'nobody\'\n---\nh1 {who}\n')
    await route('tall.kay', 'div(style="height: 3000px; background: #eee")\n')
    await route('throws.kay', '--- server\nthrow new Error(\'server boom\')\n---\np Never\n')
    await route('stall.png.ts', 'export async function GET() {\n  await Bun.sleep(120_000)\n\n  return new Response(\'\')\n}\n')
    await route('hang.kay', 'img(src="/stall.png" loading="eager" alt="")\n')
    await mkdir(join(root, 'src/components'), { recursive: true })
    await Bun.write(join(root, 'src/components/bad.kay'), '--- client\nconst label = (): string => {\n  throw new Error(\'client boom\')\n}\n---\np {label()}\n')
    await route('bad.kay', '--- script\nimport Bad from \'../components/bad.kay\'\n---\nBad\n')

    stop = await dev(root, { port: freePort(), log: () => undefined, quiet: true })

    for (let waited = 0; readDevAddress(root) === undefined && waited < 60_000; waited += 100)
      await Bun.sleep(100)
  }, 90_000)

  afterAll(async () => {
    await stop?.()
    await rm(root, { recursive: true, force: true })
  })

  it('shoots a page at a phone and a desktop width, under the base and through the trailing slash redirect', async () => {
    const report = await shot('/about')

    expect(report.url).toEndWith('/app/about')
    expect(report.status).toBe(200)
    expect(report.shots.map(each => each.size.width)).toEqual([375, 1280])
    expect(report.shots.every(each => each.size.height === 800)).toBe(true)
    expect(report.console).toEqual([])

    for (const each of report.shots)
      expect([...(await file(each.file).bytes()).subarray(0, 4)]).toEqual(PNG)
  }, 60_000)

  it('does not put the base twice on a path that has it', async () => {
    const report = await shot('/app/about', { widths: [375] })

    expect(report.url).toEndWith('/app/about')
    expect(report.status).toBe(200)
  }, 60_000)

  it('shoots a page under a locale prefix', async () => {
    const report = await shot('/fr/about', { widths: [375] })

    expect(report.url).toEndWith('/app/fr/about')
    expect(report.status).toBe(200)
  }, 60_000)

  it('shoots the whole page, cut at the limit, or the window', async () => {
    const whole = await shot('/tall', { widths: [375], fullPage: true })
    const window = await shot('/tall', { widths: [375] })

    expect(whole.shots[0]!.size.height).toBeGreaterThanOrEqual(3000)
    expect(window.shots[0]!.size.height).toBe(800)
  }, 60_000)

  it('opens the page with the cookies it is given, a visitor with none being a stranger', async () => {
    const pixels = async (report: Awaited<ReturnType<typeof screenshot>>) => new Response(Bun.file(join(root, report.shots[0]!.file))).arrayBuffer()
    const stranger = await shot('/who', { widths: [375] })
    const strangerImage = await pixels(stranger)
    const known = await shot('/who', { widths: [375], cookies: [{ name: 'session', value: 'ada' }] })
    const compared = await diffPngs(new Uint8Array(strangerImage), new Uint8Array(await pixels(known)))

    expect(compared.changed).toBeGreaterThan(0)

    const alone = await shot('/who', { widths: [375] })

    expect(alone.shots[0]!.diff!.changed).toBeGreaterThan(0)
  }, 90_000)

  it('asks the page for the dark scheme', async () => {
    const light = await shot('/box', { widths: [375] })
    const dark = await shot('/box', { widths: [375], scheme: 'dark' })
    const compared = await diffPngs(await file(light.shots[0]!.file).bytes(), await file(dark.shots[0]!.file).bytes())

    expect(compared.ratio).toBeGreaterThan(0.9)
    expect(dark.shots[0]!.file).not.toBe(light.shots[0]!.file)
  }, 60_000)

  it('keeps the shot before and diffs against it: nothing changed, then only the box that did', async () => {
    const first = await shot('/box', { widths: [375] })
    const second = await shot('/box', { widths: [375] })

    expect(first.shots[0]!.diff).toBeDefined()
    expect(second.shots[0]!.diff).toMatchObject({ changed: 0 })

    await Bun.write(join(root, 'src/routes/box.css'), BOX_CSS(150, '#00c'))

    // The dev server takes the edit in a moment.
    let third = await shot('/box', { widths: [375] })

    for (let tried = 0; third.shots[0]!.diff!.changed === 0 && tried < 40; tried++) {
      await Bun.sleep(250)
      third = await shot('/box', { widths: [375] })
    }

    const { diff } = third.shots[0]!

    expect(diff!.changed).toBeGreaterThan(0)
    expect(diff!.box!.x).toBe(0)
    expect(diff!.box!.y).toBe(0)
    expect(diff!.box!.width).toBeLessThanOrEqual(150)
    expect(diff!.box!.height).toBeLessThanOrEqual(50)
    expect(diff!.ratio).toBeLessThan(0.1)

    const files = readdirSync(join(root, '.kay/screenshots')).filter(name => name.startsWith('app_2fbox.375.light'))

    expect(files.toSorted()).toEqual(['app_2fbox.375.light.diff.png', 'app_2fbox.375.light.png', 'app_2fbox.375.light.prev.png'])
  }, 120_000)

  it('takes a shot before that is cut short for none', async () => {
    const first = await shot('/box', { widths: [375] })

    await Bun.write(join(root, first.shots[0]!.file), new Uint8Array([137, 80, 78, 71, 13, 10]))

    const again = await shot('/box', { widths: [375] })

    expect(again.shots[0]!.diff).toBeUndefined()
    expect([...(await file(again.shots[0]!.file).bytes()).subarray(0, 4)]).toEqual(PNG)
  }, 60_000)

  it('brings back the errors the dev server listed for the page', async () => {
    const report = await shot('/throws', { widths: [375] })

    expect(report.status).toBe(500)
    expect(report.problems.some(problem => problem.message.includes('server boom'))).toBe(true)
  }, 60_000)

  it('brings back the console errors of the page', async () => {
    const report = await shot('/bad', { widths: [375] })

    expect(report.console.some(line => line.includes('client boom'))).toBe(true)
    expect(existsSync(join(root, report.shots[0]!.file))).toBe(true)
  }, 60_000)

  it('shoots a page that never settles as it stands, saying why', async () => {
    const started = performance.now()
    const report = await shot('/hang', { widths: [375] })

    expect(performance.now() - started).toBeLessThan(40_000)
    expect(report.console.some(line => line.includes('timed out'))).toBe(true)
    expect(existsSync(join(root, report.shots[0]!.file))).toBe(true)
  }, 60_000)

  it('refuses a path to another host without opening the browser', async () => {
    await expect(shot('//evil.example/')).rejects.toThrow()
    await expect(shot('/a/../b')).rejects.toThrow()
  })

  it('answers through the command line, as JSON', async () => {
    await Bun.sleep(1500)

    const { code, stdout } = await run(root, ['screenshot', '/about', '--width', '375', '--format', 'json'])
    const report = JSON.parse(stdout) as Awaited<ReturnType<typeof screenshot>>

    expect(code).toBe(0)
    expect(report.status).toBe(200)
    expect(report.url).toEndWith('/app/about')
    expect(report.shots[0]!.file).toStartWith('.kay/screenshots/')
  }, 60_000)

  it('returns the images through the MCP tool, the diff only when asked', async () => {
    await Bun.sleep(1500)

    const { tools, resources } = await projectCapabilities(root)
    const server = new McpServer(tools, resources, () => undefined)
    const call = async (args: object) => {
      const reply = await server.answer(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screenshot', arguments: args } }))

      return (reply as { result: { isError?: boolean, content: { type: string, text?: string, data?: string, mimeType?: string }[] } }).result
    }

    const plain = await call({ path: '/about', width: 375 })

    expect(plain.isError).toBeFalsy()
    expect(plain.content.map(part => part.type)).toEqual(['text', 'image'])
    expect(plain.content[1]!.mimeType).toBe('image/png')
    expect([...Uint8Array.fromBase64(plain.content[1]!.data!).subarray(0, 4)]).toEqual(PNG)

    const diffed = await call({ path: '/about', width: 375, diff: true })

    expect(diffed.content.map(part => part.type)).toEqual(['text', 'image', 'image'])
  }, 90_000)
})
