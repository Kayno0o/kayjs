import type { Subprocess } from 'bun'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { pages } from '../src/server'
import { browse, browserPath } from '../src/test'

const CLI = resolve('src/cli.ts')
const MAGIC = Buffer.from([0x5E, 0x2A, 0x4D, 0x18, 0x20, 0, 0, 0])
const LISTENING = /localhost:(\d+)/
const ACCEPT = 'gzip, deflate, br, zstd, dcb, dcz'
const path = browserPath()

const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})

// A layout of the weight a site has: the 404 page, which holds nothing else, comes to a few KB.
function layout(home: string) {
  return `nav
${Array.from({ length: 40 }, (_, i) => `  a.link(href="${home}section-${i}") Section number ${i} of the documentation`).join('\n')}
main
  slot
footer
  p Built with kay, a framework for sites that load fast and stay light.
`
}

const paragraphs = (topic: string, count = 30) => Array.from({ length: count }, (_, i) => `p ${topic} paragraph ${i}: ${(i * 2654435761 % 1e9).toString(36)} and ${(i * 40503 % 65521).toString(36)}`).join('\n')

function files(config: string, i18n: boolean): Record<string, string> {
  return {
    // Rendered again in the background once a second old.
    'src/routes/tick.kay': `--- server\nexport const page = { prerender: true, revalidate: 1 }\nconst stamp = Date.now()\n---\nh1 Tick\np tick-{stamp}\n${paragraphs('Tick')}\n`,
    'tsconfig.json': tsconfig,
    'kay.config.ts': config,
    'src/routes/_layout.kay': layout('/'),
    'src/routes/_404.kay': 'h1 Nothing here\n',
    'src/routes/index.kay': `--- server\nexport const page = { prerender: true }\n---\nh1 Home\n${paragraphs('Home')}\n`,
    'src/routes/about.kay': `--- server\nexport const page = { prerender: true }\n---\nh1 About\n${paragraphs('About')}\n`,
    // Rendered per request: it reads the query.
    'src/routes/live.kay': `--- server\nconst topic = ctx.url.searchParams.get('topic') ?? 'none'\n---\nh1 Live\n  | {topic}\n${paragraphs('Live')}\n`,
    // Past the 128 KB compressed within the tick, and after a macrotask.
    'src/routes/late.kay': `--- server\nawait Bun.sleep(2)\nconst rows = Array.from({ length: 9000 }, (_, i) => 'row ' + i + ' ' + (i * 40503 % 65521).toString(36))\n---\nh1 Late\nfor row of rows\n  p {row}\n`,
    ...i18n ? { 'src/messages/en.ts': 'export default {}\n', 'src/messages/fr.ts': 'export default {}\n' } : {},
  }
}

interface Site {
  root: string
  origin: string
  server: Subprocess
  /** The mount point, '' or '/repo'. */
  base: string
}

// The site at the root, then the one under a mount point.
let sites: Site[] = []
const roots: string[] = []

async function build(root: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    throw new Error(out + err)
}

async function project(config: string, i18n = false, only?: Record<string, string>): Promise<string> {
  const cache = join(import.meta.dir, '../node_modules/.cache')

  await mkdir(cache, { recursive: true })

  const root = await mkdtemp(join(cache, 'dictionary-'))

  roots.push(root)
  await Promise.all(Object.entries(only ?? files(config, i18n)).map(async ([name, content]) => Bun.write(join(root, name), content)))

  return root
}

async function serve(root: string, base = ''): Promise<Site> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port!

  await probe.stop(true)

  const server = Bun.spawn([process.execPath, CLI, 'start', root, '--port', String(port)], { stdout: 'ignore', stderr: 'ignore' })
  const origin = `http://127.0.0.1:${port}`

  for (let tries = 0; tries < 100; tries++) {
    try {
      if ((await fetch(`${origin}/`)).ok)
        break
    }
    catch {}

    await Bun.sleep(100)
  }

  return { root, origin, server, base }
}

interface Reply {
  status: number
  headers: Headers
  body: Buffer
}

async function get(site: Site, pathname: string, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${site.origin}${pathname}`, { headers, decompress: false })

  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) }
}

const manifestOf = async (site: Site) => await Bun.file(join(outputDir(site.root), 'manifest.json')).json() as { dictionary?: { file: string, hash: string } }

function decoded(reply: Reply, dictionary: Buffer): string {
  switch (reply.headers.get('content-encoding') ?? 'identity') {
    case 'dcz': return zstdDecompressSync(reply.body.subarray(40), { dictionary }).toString()
    case 'br': return brotliDecompressSync(reply.body).toString()
    case 'zstd': return zstdDecompressSync(reply.body).toString()
    case 'gzip': return gunzipSync(reply.body).toString()
    default: return reply.body.toString()
  }
}

// A page as a browser holding the dictionary receives it, and the page the same browser would have without one.
async function asDictionary(site: Site, pathname: string, headers: Record<string, string> = {}): Promise<{ reply: Reply, text: string, plain: string, dictionary: Buffer }> {
  const { dictionary } = (await manifestOf(site))
  const bytes = Buffer.from(await Bun.file(join(outputDir(site.root), 'dist', dictionary!.file)).bytes())
  const reply = await get(site, pathname, { 'accept-encoding': ACCEPT, 'available-dictionary': `:${dictionary!.hash}:`, ...headers })
  const plain = await get(site, pathname, { 'accept-encoding': 'identity', ...headers })

  return { reply, text: decoded(reply, bytes), plain: plain.body.toString(), dictionary: bytes }
}

beforeAll(async () => {
  const [root, mounted, plain, restricted] = await Promise.all([
    project('export default {}\n'),
    project('export default { base: \'/repo\', trailingSlash: \'always\', i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\' } }\n', true),
    project('export default { compress: false }\n'),
    project('export default { security: { csp: { \'connect-src\': [\'https://api.example.com\'] } } }\n'),
  ])

  // One build at a time, as each starts the compilers.
  await build(root)
  await build(mounted)
  await build(plain)
  await build(restricted)
  sites = await Promise.all([serve(root), serve(mounted, '/repo'), serve(plain), serve(restricted)])
}, 300_000)

afterAll(async () => {
  for (const { server } of sites) {
    server.kill()
    await server.exited
  }

  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

describe('the dictionary of a build', () => {
  it('is the 404 page, written by the build under /_kay/ and named in the manifest, with its shrunk copies', async () => {
    const [root, mounted] = sites
    const { dictionary } = await manifestOf(root!)
    const dist = join(outputDir(root!.root), 'dist')

    expect(dictionary!.file).toMatch(/^dictionary-[\da-f]{16}\.txt$/)

    const bytes = await Bun.file(join(dist, dictionary!.file)).bytes()

    expect(new Bun.CryptoHasher('sha256').update(bytes).digest('base64')).toBe(dictionary!.hash)
    expect(new TextDecoder().decode(bytes)).toContain('Nothing here')
    expect(existsSync(join(dist, `${dictionary!.file}.br`))).toBe(true)
    expect((await manifestOf(mounted!)).dictionary!.hash).not.toBe(dictionary!.hash)
  })

  it('is served for the browser to keep: matching every request under the mount point, immutable, shrunk in transit as the build\'s files are', async () => {
    const [root, mounted] = sites

    for (const [site, match] of [[root!, 'match="/*"'], [mounted!, 'match="/repo{/*}?"']] as const) {
      const { dictionary } = await manifestOf(site)
      const url = `/_kay/${dictionary!.file}`
      const raw = await get(site, url, { 'accept-encoding': 'identity' })
      const shrunk = await get(site, url, { 'accept-encoding': 'br' })

      expect(raw.status).toBe(200)
      expect(raw.headers.get('use-as-dictionary')).toBe(match)
      expect(raw.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(new Bun.CryptoHasher('sha256').update(raw.body).digest('base64')).toBe(dictionary!.hash)
      expect(shrunk.headers.get('content-encoding')).toBe('br')
      expect(shrunk.headers.get('use-as-dictionary')).toBe(match)
      expect(shrunk.body.length).toBeLessThan(raw.body.length / 2)
      // The browser fetches it under the policy's connect-src.
      expect(raw.headers.get('content-security-policy')).toContain('connect-src \'self\'')
    }
  })

  it('is named by every page, whatever its status or how it was made', async () => {
    const [root, mounted] = sites

    for (const [site, prefix] of [[root!, ''], [mounted!, '/repo']] as const) {
      const { dictionary } = await manifestOf(site)
      const link = `<${prefix}/_kay/${dictionary!.file}>; rel="compression-dictionary"`

      for (const pathname of prefix === '' ? ['/', '/about', '/live?topic=a', '/nope'] : ['/', '/about/', '/live/?topic=a', '/nope/']) {
        const reply = await get(site, pathname, { 'accept-encoding': 'br' })

        expect(reply.headers.get('link'), pathname).toBe(link)
        expect(reply.headers.get('vary'), pathname).toContain('available-dictionary')
        expect(reply.headers.get('content-type'), pathname).toStartWith('text/html')
      }

      const missing = await get(site, '/_kay/missing.js')

      expect(missing.headers.get('link')).toBeNull()
    }
  })
})

describe('a page against the dictionary', () => {
  it('goes to a browser holding it as the difference from it, a prerendered page from a copy the build wrote', async () => {
    const [root] = sites
    const { dictionary } = await manifestOf(root!)

    expect(existsSync(join(outputDir(root!.root), 'pages/about.html.dcz'))).toBe(true)

    const { reply, text, plain } = await asDictionary(root!, '/about')
    const brotli = await get(root!, '/about', { 'accept-encoding': 'gzip, br' })

    expect(reply.headers.get('content-encoding')).toBe('dcz')
    expect(reply.body.subarray(0, 8)).toEqual(MAGIC)
    expect(reply.body.subarray(8, 40)).toEqual(Buffer.from(dictionary!.hash, 'base64'))
    expect(text).toBe(plain)
    expect(text).toContain('About paragraph 29')
    expect(reply.body.length).toBeLessThan(brotli.body.length / 2)
    expect(reply.headers.get('vary')).toBe('accept-encoding, available-dictionary, Save-Data')
    expect(reply.headers.get('etag')).toEndWith('-dcz"')
    expect(brotli.headers.get('etag')).toEndWith('-br"')
  })

  it('is answered 304 to the tag of its own representation, and sent whole to another', async () => {
    const [root] = sites
    const first = await asDictionary(root!, '/')
    const etag = first.reply.headers.get('etag')!
    const again = await asDictionary(root!, '/', { 'if-none-match': etag })
    const other = await asDictionary(root!, '/', { 'if-none-match': etag.replace('-dcz', '-br') })

    expect(again.reply.status).toBe(304)
    expect(again.reply.body.length).toBe(0)
    expect(again.reply.headers.get('vary')).toContain('available-dictionary')
    expect(other.reply.status).toBe(200)
    expect(other.reply.headers.get('content-encoding')).toBe('dcz')
  })

  it('goes to every other client, and to a browser holding the dictionary of another build, as it does today', async () => {
    const [root] = sites
    const { dictionary } = await manifestOf(root!)
    const stale = new Bun.CryptoHasher('sha256').update('a build before').digest('base64')
    const cases: [string, Record<string, string>][] = [
      ['no dictionary', { 'accept-encoding': ACCEPT }],
      ['an old build\'s', { 'accept-encoding': ACCEPT, 'available-dictionary': `:${stale}:` }],
      ['dcz not accepted', { 'accept-encoding': 'gzip, br, zstd', 'available-dictionary': `:${dictionary!.hash}:` }],
      ['a hash of 8000 characters', { 'accept-encoding': ACCEPT, 'available-dictionary': `:${'A'.repeat(8000)}:` }],
      ['nonsense', { 'accept-encoding': ACCEPT, 'available-dictionary': ' :dictionary' }],
    ]

    for (const pathname of ['/about', '/live?topic=b', '/nope']) {
      for (const [name, headers] of cases) {
        const reply = await get(root!, pathname, headers)

        expect(reply.headers.get('content-encoding'), `${pathname} with ${name}`).toBe(pathname === '/about' ? 'br' : 'zstd')
        expect(reply.status).toBe(pathname === '/nope' ? 404 : 200)
      }
    }
  })

  it('is compressed for a page rendered per request, the copy of a body that came again kept', async () => {
    const [root] = sites

    for (const topic of ['one', 'one', 'two']) {
      const { reply, text, plain } = await asDictionary(root!, `/live?topic=${topic}`)

      expect(reply.headers.get('content-encoding')).toBe('dcz')
      expect(text).toBe(plain)
      expect(text).toContain(topic)
    }
  })

  it('is compressed for the 404 page and for a reply that waits, however large', async () => {
    const [root] = sites
    const missing = await asDictionary(root!, '/nope')

    expect(missing.reply.status).toBe(404)
    expect(missing.reply.headers.get('content-encoding')).toBe('dcz')
    expect(missing.text).toBe(missing.plain)
    expect(missing.text).toContain('Nothing here')

    for (let time = 0; time < 2; time++) {
      const late = await asDictionary(root!, '/late')

      expect(late.plain.length).toBeGreaterThan(128 * 1024)
      expect(late.reply.headers.get('content-encoding')).toBe('dcz')
      expect(late.text).toBe(late.plain)
    }
  })

  it('goes for a site under a mount point, with a trailing slash and a locale, as for a site at the root', async () => {
    const [, mounted] = sites

    for (const pathname of ['/about/', '/fr/about/', '/fr/live/?topic=c', '/fr/nope/']) {
      const { reply, text, plain } = await asDictionary(mounted!, pathname)

      expect(reply.headers.get('content-encoding'), pathname).toBe('dcz')
      expect(text, pathname).toBe(plain)
      expect(text, pathname).toContain('/repo/')
    }

    expect(zstdDecompressSync((await asDictionary(mounted!, '/fr/about/')).reply.body.subarray(40), { dictionary: (await asDictionary(mounted!, '/about/')).dictionary }).toString()).toContain('lang="fr"')
  })
})

describe('a page that changes under the server', () => {
  it('goes to a browser holding the dictionary as its new render, not the build\'s', async () => {
    const [root] = sites
    const stamp = (text: string) => (/tick-(\d+)/).exec(text)![1]
    const first = await asDictionary(root!, '/tick')

    expect(first.reply.headers.get('content-encoding')).toBe('dcz')

    const built = stamp(first.plain)
    let latest = first

    for (let tries = 0; tries < 50 && stamp(latest.plain) === built; tries++) {
      await Bun.sleep(200)
      latest = await asDictionary(root!, '/tick')
    }

    expect(stamp(latest.plain)).not.toBe(built)

    const after = await asDictionary(root!, '/tick')

    expect(stamp(after.text)).toBe(stamp(after.plain))
    expect(after.reply.headers.get('content-encoding')).not.toBe('dcz')
  })
})

describe('development', () => {
  it('has no dictionary, even over a build that has one and with compression asked for', async () => {
    const [root] = sites
    const { dictionary } = await manifestOf(root!)
    const app = await pages({ root: root!.root, dev: true, prebuilt: true, compress: true, log: false })
    const reply = await app.handle(new Request('http://localhost/about', { headers: { 'accept-encoding': ACCEPT, 'available-dictionary': `:${dictionary!.hash}:` } }))
    const file = await app.handle(new Request(`http://localhost/_kay/${dictionary!.file}`))

    expect(reply.status).toBe(200)
    expect(reply.headers.get('link')).toBeNull()
    expect(reply.headers.get('content-encoding')).not.toBe('dcz')
    expect(reply.headers.get('vary') ?? '').not.toContain('available-dictionary')
    expect(file.headers.get('use-as-dictionary')).toBeNull()
  }, 60_000)
})

describe('a policy of the app', () => {
  it('lets the browser fetch the dictionary: kay adds \'self\' to a connect-src of the app without it', async () => {
    const restricted = sites[3]!
    const reply = await get(restricted, '/about', { 'accept-encoding': ACCEPT })

    expect(reply.headers.get('content-security-policy')).toContain('connect-src https://api.example.com \'self\';')
    expect(reply.headers.get('link')).toContain('rel="compression-dictionary"')
  })
})

describe('a server with no dictionary to use', () => {
  it('compresses nothing itself with compress: false, so a browser holding another build\'s dictionary or none gets the build\'s copies and no link', async () => {
    const plain = sites[2]!
    const dictionary = (await manifestOf(plain)).dictionary!
    const reply = await get(plain, '/about', { 'accept-encoding': ACCEPT, 'available-dictionary': `:${dictionary.hash}:` })

    expect(reply.headers.get('content-encoding')).toBe('br')
    expect(reply.headers.get('link')).toBeNull()
    expect(reply.headers.get('etag')).toEndWith('-br"')
    expect(reply.headers.get('vary')).not.toContain('available-dictionary')
  })

  it('is not built for an app with no prerendered page, or whose 404 page fails to render, which still builds', async () => {
    const dynamic = await project('export default {}\n', false, { 'tsconfig.json': tsconfig, 'kay.config.ts': 'export default {}\n', 'src/routes/_layout.kay': layout('/'), 'src/routes/live.kay': 'h1 Live\n' })
    const failing = await project('export default {}\n', false, { 'tsconfig.json': tsconfig, 'kay.config.ts': 'export default {}\n', 'src/routes/_404.kay': '--- server\nthrow new Error(\'no 404 today\')\n---\nh1 Nothing\n', 'src/routes/index.kay': `--- server\nexport const page = { prerender: true }\n---\nh1 Home\n${paragraphs('Home')}\n` })

    await build(dynamic)
    await build(failing)

    for (const root of [dynamic, failing])
      expect((await Bun.file(join(outputDir(root), 'manifest.json')).json() as { dictionary?: unknown }).dictionary).toBeUndefined()
  }, 120_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('in a browser', () => {
  it.each([0, 3])('fetches the dictionary once idle and gets its next pages as dcz, a navigation and a fetch alike, under kay\'s policy and under an app\'s connect-src (site %#)', async (index) => {
    const root = sites[index]!
    const page = await browse(`${root.origin}/`)

    try {
      const { dictionary } = await manifestOf(root)
      const fetched = `/_kay/${dictionary!.file}`
      // What the browser sent and was answered, as the wire carried it.
      const seen = (pathname: string) => {
        const response = page.responses.find(({ url }) => new URL(url).pathname === pathname)

        return response && { encoding: response.responseHeaders['content-encoding'], dictionary: response.requestHeaders['available-dictionary'] }
      }

      // Fetched when the page is idle, at low priority.
      await page.waitForResponse(fetched)

      expect(seen('/')!.encoding).not.toBe('dcz')

      // Chrome writes the dictionary to its store a moment after the last byte, with nothing to wait on, so a navigation going out before it is stored goes without.
      for (let tries = 0; tries < 20 && seen('/about')?.encoding !== 'dcz'; tries++) {
        page.responses.length = 0

        await page.goto('/about')
        await page.waitForResponse('/about')
      }

      expect(seen('/about')).toMatchObject({ encoding: 'dcz', dictionary: expect.stringContaining(dictionary!.hash.slice(0, 10)) })
      expect(await page.text('h1')).toBe('About')

      const text = await page.evaluate(async () => (await fetch('/live?topic=fetched')).text())

      await page.waitForResponse('/live')

      expect(seen('/live')).toMatchObject({ encoding: 'dcz' })
      expect(text).toContain('fetched')
      expect(page.errors).toEqual([])
    }
    finally {
      page.close()
    }
  }, 60_000)
})

describe('a compiled executable', () => {
  it('serves the dictionary and the prerendered pages\' dcz copies from what it embeds, started in an empty folder', async () => {
    const root = await project('export default {}\n')
    const executable = join(root, 'bin/server')
    const empty = await mkdtemp(join(tmpdir(), 'dictionary-exe-'))

    roots.push(empty)
    await build(root, '--compile', executable)

    const child = Bun.spawn([executable], { cwd: empty, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production', PORT: '0' } })

    try {
      const reader = child.stdout.getReader()
      let output = ''

      while (!LISTENING.test(output)) {
        const { value, done } = await reader.read()

        if (done)
          throw new Error(`the executable exited: ${output}${await new Response(child.stderr).text()}`)

        output += new TextDecoder().decode(value)
      }

      const site: Site = { root, origin: `http://localhost:${LISTENING.exec(output)![1]}`, server: child, base: '' }
      const { dictionary } = await manifestOf(site)
      const file = await get(site, `/_kay/${dictionary!.file}`, { 'accept-encoding': 'identity' })

      expect(file.status).toBe(200)
      expect(file.headers.get('use-as-dictionary')).toBe('match="/*"')
      expect(new Bun.CryptoHasher('sha256').update(file.body).digest('base64')).toBe(dictionary!.hash)

      for (const pathname of ['/about', '/live?topic=exe']) {
        const { reply, text, plain } = await asDictionary(site, pathname)

        expect(reply.headers.get('content-encoding'), pathname).toBe('dcz')
        expect(text, pathname).toBe(plain)
      }
    }
    finally {
      child.kill()
      await child.exited
    }
  }, 300_000)
})

describe('a static export', () => {
  it('has no dictionary: a static host cannot answer by what the browser holds', async () => {
    const root = await project('export default {}\n')

    await build(root, '--static')

    const output = outputDir(root)
    const exported = await readdir(join(root, 'dist'), { recursive: true })

    expect((await Bun.file(join(output, 'manifest.json')).json() as { dictionary?: unknown }).dictionary).toBeUndefined()
    expect(exported.filter(file => file.includes('dictionary'))).toEqual([])
    expect(await Bun.file(join(root, 'dist/about.html')).text()).toContain('About paragraph 29')
    expect(exported.filter(file => file.endsWith('.dcz'))).toEqual([])
  }, 120_000)
})
