import type { PagesOptions } from '../src/server/app'
import type { ClientBuild } from '../src/server/client'
import type { Route } from '../src/server/routes'
import type { TestPage } from '../src/test'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { styledClassNames } from '../src/build/class-rules'
import { buildClient } from '../src/build/client'
import { parse } from '../src/build/supports'
import { warnServerClasses } from '../src/build/warn-classes'
import { modeOf, PRODUCTION, resolveProject } from '../src/project'
import { logSink, setLogSink } from '../src/runtime/log'
import { servePages } from '../src/server/app'
import { INLINE_LIMIT, readClient, readInlineStyles } from '../src/server/client'
import { sourceHash } from '../src/server/csp'
import { prerenderPages } from '../src/server/prerender'
import { browse, browserPath } from '../src/test'
import { fixtureCopy } from './scratch'

// Many arbitrary values, each its own rule, so the app's one stylesheet passes what a head may inline.
const bulk = (seed: number) => Array.from({ length: 1800 }, (_, index) => `bg-[#${(((index + seed) * 2654435761) >>> 8).toString(16).padStart(6, '0').slice(0, 6)}] p-[${index + 3 + seed}px]`).join(' ')
const BULK = bulk(0)
// A second page with as many rules of its own, so each of the two leaves out the other's.
const OTHER_BULK = bulk(5000)
// Rules weighing between half the limit and the limit, which a head still inlines.
const HALF = bulk(9000).split(' ').slice(0, 900).join(' ')
const LISTENING = /port (\d+)/
const STYLE = /<style>([\s\S]*?)<\/style>/g
const ROUTE_COPY = /\/_kay\/[^/]+\.r-[a-z0-9]+\.css$/
const browserInstalled = browserPath() !== undefined

// A page rendered at build time that shows a class built from data.
const TONE = '--- server\nexport const page = { prerender: true }\nconst tone = [\'ring\', 4].join(\'-\')\n---\nh1 Tone\np(class={tone}) built\n'

let root = ''
let client: ClientBuild

type App = Awaited<ReturnType<typeof servePages>>

// A copy of the fixture with a page whose own rules pass the limit, built with Tailwind.
async function copyOfFixture(): Promise<string> {
  const dir = resolve(await fixtureCopy('page-styles'))

  await Bun.write(join(dir, 'src/routes/bulk.kay'), `h1 Bulk\na.to-other(href="/other-bulk") other\np(class="${BULK}") bulk\n`)
  await Bun.write(join(dir, 'src/routes/half.kay'), `h1 Half\np(class="${HALF}") half\n`)
  // Tailwind writes a star variant's rule as `:is(.\*\:p-2 > *)`, the class inside the :is(), inside another one when stacked, and before a `.x` when followed by `[&.x]`; the no-star page uses `x`.
  await Bun.write(join(dir, 'src/routes/star.kay'), `ul.*:p-2.**:m-1.*:hover:p-1(class="*:*:p-2 *:[&.x]:p-3 *:hover:*:p-4")\n  li.x star\n`)
  await Bun.write(join(dir, 'src/routes/no-star.kay'), 'p.italic.x no star\n')
  await Bun.write(join(dir, 'src/routes/other-bulk.kay'), `h1 Other\np(class="${OTHER_BULK}") other\n`)
  // Pages that build a class from data and are rendered at build time; the second has rules of its own past the limit, so its head links a copy.
  await Bun.write(join(dir, 'src/routes/tone.kay'), TONE)
  await Bun.write(join(dir, 'src/routes/tone-copy.kay'), `${TONE}p(class="${BULK}") bulk\n`)
  // The same expression on a page with a param, rendered per request.
  await Bun.write(join(dir, 'src/routes/item/[slug].kay'), '--- server\nconst tone = [\'ring\', 4].join(\'-\')\n---\nh1 Item\np(class={tone}) per request\n')
  // A failure and a missing page have chains of their own, and a page rendering a collection's Markdown may name any class.
  await Bun.write(join(dir, 'src/routes/_404.kay'), 'h1 Gone\np.italic nothing here\n')
  await Bun.write(join(dir, 'src/routes/_error.kay'), 'h1 Broken\np.tracking-wide went wrong\n')
  await Bun.write(join(dir, 'src/routes/boom.kay'), '--- server\nthrow new Error(\'boom\')\n---\nh1 Boom\n')
  await Bun.write(join(dir, 'src/content.config.ts'), 'import { s } from \'kay\'\nimport { collection } from \'kay/content\'\n\nexport const notes = collection(\'content/notes\', { schema: s.Object({ title: s.String() }) })\n')
  // Raw HTML names a class; a fenced block and a code span only show one as text.
  await Bun.write(join(dir, 'src/content/notes/first.md'), '---\ntitle: First\n---\n\nHello <span class="ring-4">there</span> `text-red-500`\n\n```html\n<i class="md:flex"></i>\n```\n')
  // A script that is no component writes markup into the Markdown, as a highlighter plugin does.
  await Bun.write(join(dir, 'src/markup.ts'), 'export const wrapper = \'<div class="border-red-500"></div>\'\n')
  await Bun.write(join(dir, 'src/routes/notes.kay'), '--- server\nimport { notes } from \'../content.config\'\n\nconst { Content } = (await notes.get(\'first\'))!\n---\nh1 Notes\nContent\n')

  return dir
}

// The heads a server writes are kept per `styles` map, so each server gets a map of its own.
async function serve(options: PagesOptions & { dev?: boolean } = {}, built = client): Promise<App> {
  const mode = modeOf({ dev: options.dev ?? false, prebuilt: options.dev !== true })
  const config = { routes: 'src/routes', compress: false, ...options }

  return servePages(resolveProject(root, config, mode), () => ({ ...built, styles: new Map(built.styles), inlineStyles: undefined, inlineSizes: undefined, pageStyles: undefined }))
}

interface Head {
  html: string
  styles: string
  // The stylesheets it links.
  blocking: string[]
}

async function head(app: App, path: string): Promise<Head> {
  const response = await app.handle(new Request(`http://localhost${path}`))
  const html = await response.text()

  return {
    html,
    styles: [...html.matchAll(STYLE)].map(match => match[1]!).join('\n'),
    blocking: [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1]!),
  }
}

// Whether the rules written inline hold one for the class, as the class attribute writes it: `data-[state=open]:flex`.
function styles(css: string, name: string): boolean {
  return styledClassNames(parse(css)).has(name)
}

// Whether the rules written inline hold one for the class.
function hasRule(styles: string, name: string): boolean {
  return styles.includes(`.${name.replaceAll(':', '\\:').replaceAll('/', '\\/')}`)
}

function firstOf(classes: string): string {
  return classes.slice(0, classes.indexOf(' '))
}

// A class as a selector writes it.
function escaped(name: string): string {
  return `.${name.replaceAll(/[^\w-]/g, '\\$&')}`
}

async function sharedText(built: ClientBuild, url: string): Promise<string> {
  return Bun.file(join(built.dir, url.slice('/_kay/'.length))).text()
}

// The layout's whole stylesheet, which no page links in full but holds every rule.
function wholeUrl(): string {
  return client.styles.get(join(root, 'src/routes/_layout.kay'))!
}

beforeAll(async () => {
  root = await copyOfFixture()
  client = await buildClient(root, { plugins: [tailwind] })
}, 120_000)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('lateStyles', () => {
  it('links the whole stylesheet after the inline rules, where it is off by default', async () => {
    const off = await head(await serve(), '/data')
    const on = await head(await serve({ lateStyles: true }), '/data')

    expect(off.html).not.toContain('data-kay-rest')
    expect(on.html).toMatch(/<link rel="stylesheet" href="[^"]+" media="print" data-kay-rest>/)
    expect(on.html).toContain('<noscript><link rel="stylesheet" href="')
    expect(on.html).toContain('<script data-kay-rest>')
    expect(on.html.indexOf('data-kay-rest')).toBeGreaterThan(on.html.lastIndexOf('</style>'))
    expect(hasRule(on.styles, 'ring-4')).toBe(false)
    expect(await sharedText(client, wholeUrl())).toContain('.ring-4')
  })

  it('has the script of the whole stylesheet allowed by the policy, and only when on', async () => {
    const policy = async (late: boolean) => {
      const served = await serve({ lateStyles: late, security: { csp: { 'script-src': ['\'self\''] } } })

      return (await served.handle(new Request('http://localhost/data'))).headers.get('content-security-policy') ?? ''
    }

    expect(await policy(true)).toContain(sourceHash('for(const l of document.querySelectorAll("link[data-kay-rest]"))l.media="all"'))
    expect(await policy(false)).not.toContain(sourceHash('for(const l of document.querySelectorAll("link[data-kay-rest]"))l.media="all"'))
  })

  it('warns of no class when on, as every rule ships', async () => {
    const warned: string[] = []
    const previous = logSink()
    const dir = resolve(await fixtureCopy('page-styles'))

    setLogSink((level, message) => void (level === 'warn' && warned.push(message)))

    try {
      await Bun.write(join(dir, 'src/components/runtime.kay'), '---\nfunction paint(event: MouseEvent) {\n  (event.currentTarget as HTMLElement).classList.add(String(Date.now()))\n}\n---\nbutton.runtime(onClick={paint}) paint\n')
      await Bun.write(join(dir, 'src/routes/runtime.kay'), '---\nimport Runtime from \'../components/runtime.kay\'\n---\nh1 Runtime\nRuntime\n')

      const built = await buildClient(dir, { plugins: [tailwind], lateStyles: true })

      expect(warned).toEqual([])
      expect(built.unresolved).toEqual([])
    }
    finally {
      if (previous)
        setLogSink(previous)
      else
        delete (globalThis as Record<symbol, unknown>)[Symbol.for('kay.log')]

      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('a page\'s head', () => {
  it('is built from a stylesheet past what a head inlines', async () => {
    const sizes = [...(await readInlineStyles(client, '')).values()].map(css => Bun.gzipSync(css).length)

    expect(Math.max(...sizes)).toBeGreaterThan(INLINE_LIMIT)
  })

  it('carries the rules its own components use and nothing else, with no stylesheet to load after the paint', async () => {
    const about = await head(await serve(), '/about')

    expect(about.blocking).toEqual([])
    expect(about.html).not.toContain('data-kay-rest')
    expect(about.html).not.toContain('<noscript>')
    expect(about.html).not.toContain('<link rel="stylesheet"')

    // The layout's own, the page's component, and the stylesheet's hand-written rule.
    for (const name of ['px-4', 'font-bold', 'underline', 'decoration-wavy', 'mark'])
      expect(hasRule(about.styles, name), name).toBe(true)

    for (const name of ['text-red-500', 'md:flex', 'bg-lime-300', 'border-red-500', 'ring-4'])
      expect(hasRule(about.styles, name), name).toBe(false)

    const shared = await sharedText(client, wholeUrl())

    for (const name of ['underline', 'text-red-500', 'bg-lime-300', 'ring-4'])
      expect(shared).toContain(`.${name}`)
  })

  it('leaves out the rules of a component only another page renders', async () => {
    const app = await serve()
    const home = await head(app, '/')
    const about = await head(app, '/about')
    const widgets = await head(app, '/widgets')

    expect(hasRule(home.styles, 'text-red-500')).toBe(true)
    expect(hasRule(home.styles, 'md:flex')).toBe(true)
    expect(hasRule(home.styles, 'underline')).toBe(false)
    expect(hasRule(about.styles, 'underline')).toBe(true)
    expect(hasRule(about.styles, 'bg-lime-300')).toBe(false)
    expect(hasRule(widgets.styles, 'underline')).toBe(false)
  })

  it('carries the rules of a component rendered only inside an island', async () => {
    const widgets = await head(await serve(), '/widgets')

    expect(widgets.html).toContain('<script type="module"')
    expect(hasRule(widgets.styles, 'bg-lime-300')).toBe(true)
  })

  it('carries the rules of static classes whose names hold quotes, equals signs and angle brackets', async () => {
    const rules = await head(await serve(), '/static')

    for (const name of ['data-[state=open]:bg-red-500', '[&>svg]:size-4', 'font-[\'Fira_Code\']', 'has-[>img]:p-2', 'after:content-[\'x\']', '2xl:p-4'])
      expect(styles(rules.styles, name), name).toBe(true)
  })

  it('leaves out the rule of a class built from a runtime string, which the whole stylesheet only holds', async () => {
    const tie = await head(await serve(), '/tie')

    expect(styles(tie.styles, 'text-sm')).toBe(true)
    expect(styles(tie.styles, 'text-xl')).toBe(false)
    expect(tie.blocking).toEqual([])
    expect(await sharedText(client, wholeUrl())).toContain('.text-xl')
  })

  it('writes the rules an island sets after load in the order of the whole stylesheet', async () => {
    const late = await head(await serve(), '/late')
    const order = (css: string) => [...css.matchAll(/\.([\w\\[\]#:/.-]+)\{/g)].map(match => match[1]!)
    const whole = order(await sharedText(client, wholeUrl()))

    for (const name of ['bg-amber-200', 'text-sm', 'text-xl'])
      expect(hasRule(late.styles, name), name).toBe(true)

    let at = 0

    for (const name of order(late.styles)) {
      at = whole.indexOf(name, at)
      expect(at, name).not.toBe(-1)
    }
  })

  it('carries the rule of a class its page builds from a template string', async () => {
    const dynamic = await head(await serve(), '/dynamic')

    expect(hasRule(dynamic.styles, 'border-red-500')).toBe(true)
  })

  it('carries the rule of a star variant on the page that writes it, and not on one that does not', async () => {
    const app = await serve()
    const star = await head(app, '/star')
    const plain = await head(app, '/no-star')

    for (const name of ['*:p-2', '**:m-1', '*:hover:p-1', '*:*:p-2', '*:[&.x]:p-3', '*:hover:*:p-4'])
      expect(star.styles, name).toContain(escaped(name))

    for (const name of ['*:p-2', '**:m-1', '*:hover:p-1', '*:*:p-2', '*:[&.x]:p-3', '*:hover:*:p-4'])
      expect(plain.styles, name).not.toContain(escaped(name))

    expect(await sharedText(client, wholeUrl())).toContain(escaped('*:p-2'))
  })

  it('does not carry the rule of a class nothing on the page writes, though another page does', async () => {
    const data = await head(await serve(), '/data')

    expect(hasRule(data.styles, 'ring-4')).toBe(false)
    expect(data.blocking).toEqual([])
    expect(await sharedText(client, wholeUrl())).toContain('.ring-4')
  })

  it('carries the rules of the classes a page rendering a collection\'s Markdown may show, and leaves out the rest', async () => {
    const notes = await head(await serve(), '/notes')

    // Raw HTML in the entry, and a script writing markup into it.
    for (const name of ['ring-4', 'border-red-500'])
      expect(hasRule(notes.styles, name), name).toBe(true)

    // Text in a fenced block or a code span is no element, and the components of other pages are not its own.
    for (const name of ['text-red-500', 'md:flex', 'bg-lime-300', 'underline'])
      expect(hasRule(notes.styles, name), name).toBe(false)

    expect(notes.blocking).toEqual([])
  })

  it('writes the head of the missing page and of the error page as any page\'s', async () => {
    const app = await serve()
    const missing = await app.handle(new Request('http://localhost/nowhere'))
    const failed = await app.handle(new Request('http://localhost/boom'))

    expect(missing.status).toBe(404)
    expect(failed.status).toBe(500)

    for (const [response, rule, other] of [[missing, 'italic', 'tracking-wide'], [failed, 'tracking-wide', 'italic']] as const) {
      const html = await response.text()
      const inline = [...html.matchAll(STYLE)].map(match => match[1]!).join('\n')

      expect(hasRule(inline, rule), rule).toBe(true)
      expect(hasRule(inline, other), other).toBe(false)
      expect(html).not.toContain('<link rel="stylesheet"')
    }
  })

  it('links a copy of the stylesheet without the rules a route never renders, when its own rules pass the limit', async () => {
    const app = await serve()
    const bulk = await head(app, '/other-bulk')
    const other = await head(app, '/bulk')
    const whole = wholeUrl()

    for (const page of [bulk, other]) {
      expect(page.styles).toBe('')
      expect(page.blocking).toHaveLength(1)
      expect(page.blocking[0]).toMatch(ROUTE_COPY)
    }

    expect(bulk.blocking[0]).not.toBe(other.blocking[0])

    const wholeText = await sharedText(client, whole)
    const copy = await sharedText(client, bulk.blocking[0]!)
    const own = escaped(firstOf(OTHER_BULK))
    const foreign = escaped(firstOf(BULK))

    expect(copy.length).toBeLessThan(wholeText.length * 0.75)
    expect(wholeText).toContain(foreign)
    expect(copy).toContain(own)
    expect(copy).not.toContain(foreign)
    // Rules nothing names stay, and the rules of the other route's components go.
    for (const name of ['underline', 'bg-lime-300', 'text-red-500'])
      expect(hasRule(copy, name), name).toBe(false)

    expect(copy).toContain('@layer theme')
    expect(copy).toContain('@property')
  })

  it('inlines the rules of a route weighing between half the limit and the limit instead of linking a copy, which paints the first view sooner', async () => {
    const half = await head(await serve(), '/half')
    const size = Bun.gzipSync(half.styles).length

    expect(size).toBeGreaterThan(INLINE_LIMIT / 2)
    expect(size).toBeLessThanOrEqual(INLINE_LIMIT)
    expect(half.blocking).toEqual([])
    expect(half.styles).toContain(escaped(firstOf(HALF)))
  })

  it('keeps the rules of a route copy in the order of the shared stylesheet', async () => {
    const copy = await sharedText(client, (await head(await serve(), '/bulk')).blocking[0]!)
    const wholeText = await sharedText(client, wholeUrl())
    const order = (css: string) => [...css.matchAll(/\.([\w\\[\]#:/.-]+)\{/g)].map(match => match[1]!)
    const whole = order(wholeText)
    let at = 0

    for (const name of order(copy)) {
      at = whole.indexOf(name, at)
      expect(at, name).not.toBe(-1)
    }
  })

  it('writes the copy once, named by its text, and finds it again when the server restarts', async () => {
    const before = await Bun.file(join(client.dir, ...(await head(await serve(), '/bulk')).blocking[0]!.slice('/_kay/'.length).split('/'))).stat()
    const again = await head(await serve(), '/bulk')

    expect((await Bun.file(join(client.dir, ...again.blocking[0]!.slice('/_kay/'.length).split('/'))).stat()).mtimeMs).toBe(before.mtimeMs)
  })

  it.each([undefined, '/docs'])('goes out under the mount point %s, each rule let through a strict style-src by its hash and compressed whole', async (base) => {
    const built = base === undefined ? client : await buildClient(root, { plugins: [tailwind], base })
    const security = { csp: { 'style-src': ['\'self\''] } }
    // A proxy strips the mount point before the request reaches the server.
    const path = '/about'
    const plain = await (await serve({ base, security }, built)).handle(new Request(`http://localhost${path}`))
    const html = await plain.text()
    const policy = plain.headers.get('content-security-policy')!
    const styles = [...html.matchAll(STYLE)].map(match => match[1]!)

    expect(styles.length).toBeGreaterThan(0)
    for (const style of styles)
      expect(policy).toContain(sourceHash(style))

    expect(html).not.toContain('<link rel="stylesheet"')
    // A style several pages share is let through once.
    const hashes = policy.match(/'sha256-[^']+'/g)!

    expect(new Set(hashes).size).toBe(hashes.length)

    const compressed = await (await serve({ base, security, compress: true }, built)).handle(new Request(`http://localhost${path}`, { headers: { 'accept-encoding': 'br, gzip' } }))

    expect(compressed.headers.get('content-encoding')).toBe('gzip')
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await compressed.arrayBuffer())))).toBe(html)
  })

  it('links the shared stylesheet when the copy cannot be written, and with offline on', async () => {
    const copy = (await head(await serve(), '/bulk')).blocking[0]!
    const file = join(client.dir, copy.slice('/_kay/'.length))

    await rm(file)
    await mkdir(file)

    const blocked = await head(await serve(), '/bulk')

    expect(blocked.blocking[0]).not.toMatch(ROUTE_COPY)
    await rm(file, { recursive: true })

    const offline = await head(await serve({ offline: true }), '/bulk')

    expect(offline.blocking[0]).not.toMatch(ROUTE_COPY)
    expect((await head(await serve(), '/bulk')).blocking[0]).toBe(copy)
  })

  it('replaces a copy cut short under its name', async () => {
    const copy = (await head(await serve(), '/bulk')).blocking[0]!
    const file = join(client.dir, copy.slice('/_kay/'.length))
    const text = await Bun.file(file).text()

    await Bun.write(file, text.slice(0, 100))
    await head(await serve(), '/bulk')
    expect(await Bun.file(file).text()).toBe(text)
  })

  it('puts the mount point on the href of a route copy, which is cut from the stylesheet as the build wrote it', async () => {
    const built = await buildClient(root, { plugins: [tailwind], base: '/docs' })
    const bulk = await head(await serve({ base: '/docs' }, built), '/bulk')

    expect(bulk.blocking).toHaveLength(1)
    expect(bulk.blocking[0]).toMatch(/^\/docs\/_kay\/[^/]+\.r-[a-z0-9]+\.css$/)
    expect(await Bun.file(join(built.dir, bulk.blocking[0]!.slice('/docs/_kay/'.length))).text()).toContain(escaped(firstOf(BULK)))
  })

  it('stays as it was for inlineStyles true and false, and in development', async () => {
    const forced = await head(await serve({ inlineStyles: true }), '/about')
    const linked = await head(await serve({ inlineStyles: false }), '/about')
    const dev = await head(await serve({ dev: true }), '/about')

    expect(hasRule(forced.styles, 'bg-lime-300')).toBe(true)
    expect(linked.html).not.toContain('<style>')
    expect(linked.blocking).toHaveLength(1)
    expect(dev.html).not.toContain('<style>')

    for (const mode of [{ inlineStyles: true }, { inlineStyles: false }, { dev: true }])
      expect((await head(await serve(mode), '/bulk')).blocking[0] ?? '', JSON.stringify(mode)).not.toMatch(ROUTE_COPY)
  })

  it('is written into a page kept at build time, its hash known to the server that serves it', async () => {
    expect(await prerenderPages(resolveProject(root, { routes: 'src/routes' }, PRODUCTION), client)).toBeGreaterThan(0)

    const file = await Bun.file(join(outputDir(root), 'pages/prerendered.html')).text()
    const styles = [...file.matchAll(STYLE)].map(match => match[1]!).join('\n')

    expect(file).not.toContain('data-kay-rest')
    expect(file).not.toContain('<link rel="stylesheet"')
    expect(hasRule(styles, 'underline')).toBe(true)
    expect(hasRule(styles, 'bg-lime-300')).toBe(false)

    const served = await servePages(resolveProject(root, { routes: 'src/routes', security: { csp: { 'style-src': ['\'self\''] } } }, PRODUCTION), async () => (await readClient(root))!)
    const response = await served.handle(new Request('http://localhost/prerendered'))
    const body = await response.text()

    expect(body).toBe(file)
    for (const [, style] of body.matchAll(STYLE))
      expect(response.headers.get('content-security-policy')).toContain(sourceHash(style!))
  }, 120_000)
})

describe('the classes a page cannot see', () => {
  // Builds a copy of the fixture with an island adding a class from a value, and returns what the build warned and the classes two pages carry.
  async function builtWith(css: string): Promise<{ warned: string[], about: string[], data: string[] }> {
    const dir = resolve(await fixtureCopy('page-styles'))
    const warned: string[] = []
    const previous = logSink()

    await Bun.write(join(dir, 'src/app.css'), `@import "tailwindcss" source("..");\n\n.mark { outline: 1px solid; }\n${css}`)
    await Bun.write(join(dir, 'src/components/runtime.kay'), '---\nfunction paint(event: MouseEvent) {\n  (event.currentTarget as HTMLElement).classList.add(String(Date.now()))\n}\n---\nbutton.runtime(onClick={paint}) paint\n')
    await Bun.write(join(dir, 'src/routes/runtime.kay'), '---\nimport Runtime from \'../components/runtime.kay\'\n---\nh1 Runtime\nRuntime\n')
    setLogSink((level, message) => void (level === 'warn' && warned.push(message)))

    try {
      const { styleUses } = await buildClient(dir, { plugins: [tailwind] })
      const carried = (route: string) => (styleUses!.entries.get(join(dir, `src/routes/${route}.kay`)) as number[]).map(index => styleUses!.classes[index]!)

      return { warned, about: carried('about'), data: carried('data') }
    }
    finally {
      if (previous)
        setLogSink(previous)
      else
        delete (globalThis as Record<symbol, unknown>)[Symbol.for('kay.log')]

      await rm(dir, { recursive: true, force: true })
    }
  }

  it('warns of an island setting a class from a value, naming the island', async () => {
    const { warned, about, data } = await builtWith('')

    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('island src/components/runtime.kay:3')
    expect(warned[0]).toContain('classList.add')
    expect(warned[0]).toContain('@source inline')
    expect(about).not.toContain('ring-4')
    expect(data).not.toContain('ring-4')
  }, 120_000)

  it('keeps the classes the app lists with `@source inline` on every page, and takes that as the answer to the warning', async () => {
    const { warned, about, data } = await builtWith('@source inline("ring-4");\n')

    expect(warned).toEqual([])
    expect(about).toContain('ring-4')
    expect(data).toContain('ring-4')
  }, 120_000)
})

describe('a class a server builds from data', () => {
  // Rules of its own past the limit make the head of the second one link a copy, where the class must be as well.
  async function prerendered(): Promise<Route[]> {
    const routes: Route[] = []

    expect(await prerenderPages(resolveProject(root, { routes: 'src/routes' }, PRODUCTION), client, { routes })).toBeGreaterThan(0)

    return routes
  }

  it('keeps the rules of the classes a prerendered page shows, inline', async () => {
    await prerendered()

    const file = await Bun.file(join(outputDir(root), 'pages/tone.html')).text()
    const rules = [...file.matchAll(STYLE)].map(match => match[1]!).join('\n')

    expect(hasRule(rules, 'ring-4')).toBe(true)
    expect(file).not.toContain('<link rel="stylesheet"')
    // The manifest keeps it, so a server rendering the page again writes the same head.
    const read = (await readClient(root))!
    const tone = read.styleUses!.entries.get(join(root, 'src/routes/tone.kay')) as number[]

    expect(tone.map(index => read.styleUses!.classes[index])).toContain('ring-4')
  }, 120_000)

  it('keeps them in the copy of the stylesheet a head links when its own rules pass the limit', async () => {
    await prerendered()

    const file = await Bun.file(join(outputDir(root), 'pages/tone-copy.html')).text()
    const copy = file.match(/<link rel="stylesheet" href="(\/_kay\/[^"]+\.r-[a-z0-9]+\.css)">/)

    expect(copy).not.toBeNull()
    expect(hasRule(await Bun.file(join(client.dir, copy![1]!.slice('/_kay/'.length))).text(), 'ring-4')).toBe(true)
  }, 120_000)

  it('leaves no stylesheet copy that no page or head links', async () => {
    await prerendered()

    const pagesDir = join(outputDir(root), 'pages')
    const linking = [...(client.pageStyles?.values() ?? [])].map(head => head.html)

    for (const name of (await readdir(pagesDir, { recursive: true })).filter(entry => entry.endsWith('.html')))
      linking.push(await Bun.file(join(pagesDir, name)).text())

    const copies = (await readdir(client.dir)).filter(name => (/\.r-[a-z0-9]+\.css$/).test(name))

    expect(copies.length).toBeGreaterThan(0)
    for (const copy of copies)
      expect(linking.some(html => html.includes(copy)), copy).toBe(true)
  }, 120_000)

  it('warns of the same expression on a page rendered per request, and of none on a page that was rendered', async () => {
    const routes = await prerendered()
    const warned: string[] = []
    const previous = logSink()

    setLogSink((level, message) => void (level === 'warn' && warned.push(message)))

    try {
      warnServerClasses(root, client, routes)
    }
    finally {
      if (previous)
        setLogSink(previous)
      else
        delete (globalThis as Record<symbol, unknown>)[Symbol.for('kay.log')]
    }

    // `/tone` and `/tone-copy` were rendered, so their heads carry the rule; the page with a param is told, with the expression and the ways out.
    expect(warned.filter(message => message.includes('src/routes/tone'))).toEqual([])

    const item = warned.filter(message => message.includes('src/routes/item/[slug].kay:5'))

    expect(item).toHaveLength(1)
    expect(item[0]).toContain('class attribute `tone`')
    expect(item[0]).toContain('@source inline')
    expect(item[0]).toContain('lateStyles: true')
  }, 120_000)
})

describe('a page kept at build time under a mount point', () => {
  it('carries its rules inline and links no stylesheet', async () => {
    const built = await buildClient(root, { plugins: [tailwind], base: '/docs' })

    expect(await prerenderPages(resolveProject(root, { routes: 'src/routes', base: '/docs' }, PRODUCTION), built)).toBeGreaterThan(0)

    const file = await Bun.file(join(outputDir(root), 'pages/prerendered.html')).text()

    expect(file).toContain('<style>')
    expect(file).not.toContain('<link rel="stylesheet"')
  }, 120_000)
})

// Starts the fixture's server in production in a copy of it, and tells where it listens.
async function startFixture(env: Record<string, string> = {}): Promise<{ dir: string, server: Bun.Subprocess<'ignore', 'pipe', 'pipe'>, origin: string }> {
  const dir = await copyOfFixture()
  const server = Bun.spawn(['bun', 'server.ts'], { cwd: dir, env: { ...process.env, NODE_ENV: 'production', ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const reader = server.stdout.getReader()
  let output = ''

  for (let match = LISTENING.exec(output); !match; match = LISTENING.exec(output)) {
    const { value, done } = await reader.read()

    if (done)
      throw new Error(`the fixture exited without listening: ${await new Response(server.stderr).text()}`)

    output += new TextDecoder().decode(value)
  }

  reader.releaseLock()

  return { dir, server, origin: `http://localhost:${LISTENING.exec(output)![1]}` }
}

describe.skipIf(!browserInstalled && (process.env.CI ?? '') === '')('the page swap, in Chromium', () => {
  let server: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  let origin: string
  let appDir = ''

  beforeAll(async () => {
    ;({ dir: appDir, server, origin } = await startFixture())
  }, 120_000)

  afterAll(async () => {
    server?.kill()
    await server?.exited
    await rm(appDir, { recursive: true, force: true })
  })

  const style = async (page: TestPage, selector: string, property: 'textDecorationLine' | 'boxShadow' | 'backgroundColor') => page.evaluate((selector: string, property: 'textDecorationLine' | 'boxShadow' | 'backgroundColor') => getComputedStyle(document.querySelector(selector)!)[property], selector, property)
  const inlined = async (page: TestPage) => page.evaluate(() => [...document.head.querySelectorAll('style')].map(element => element.textContent).join('\n'))

  it('applies the rules of classes an island sets after load, in the order of the whole stylesheet, with no stylesheet to load', async () => {
    const page = await browse(`${origin}/late`)

    expect(await page.evaluate(() => document.head.querySelectorAll('link[rel="stylesheet"]').length)).toBe(0)
    expect(await style(page, '.late', 'backgroundColor')).toBe('rgba(0, 0, 0, 0)')
    await page.click('.late')
    await page.waitUntil(() => getComputedStyle(document.querySelector('.late')!).backgroundColor !== 'rgba(0, 0, 0, 0)')
    // `text-xl` follows `text-sm` in the whole stylesheet, so it wins whichever the island added last.
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.late')!).fontSize)).toBe('20px')
    await page.close()
  })

  it('brings the rules the next page needs with the swap, from a page to one using a component the first does not', async () => {
    const page = await browse(`${origin}/`)

    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    expect(await inlined(page)).not.toContain('.decoration-wavy')
    await page.click('a.about')
    await page.waitFor('h1', { text: 'About' })
    expect(await inlined(page)).toContain('.decoration-wavy')
    expect(await style(page, '.fancy', 'textDecorationLine')).toBe('underline')
    expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
    await page.click('a.widgets')
    await page.waitFor('h1', { text: 'Widgets' })
    expect(await inlined(page)).toContain('.bg-lime-300')
    expect(await inlined(page)).not.toContain('.decoration-wavy')
    expect(await style(page, '.counter', 'backgroundColor')).not.toBe('rgba(0, 0, 0, 0)')
    expect(await page.evaluate(() => document.head.querySelectorAll('link[rel="stylesheet"]').length)).toBe(0)
    await page.back()
    await page.waitFor('h1', { text: 'About' })
    expect(await style(page, '.fancy', 'textDecorationLine')).toBe('underline')
    await page.close()
  })

  it('keeps a noscript whose markup holds an ampersand through a swap, as the server serves it', async () => {
    const page = await browse(`${origin}/`)

    // Both pages carry the same noscript, as a layout's would.
    await page.route(`${origin}/*`, async (request) => {
      const response = await request.fetch()
      const html = (response.headers['content-type'] ?? '').includes('text/html')

      await request.fulfill(html ? { ...response, body: response.text().replace('</head>', '<noscript><link rel="stylesheet" href="/amp.css?a=1&b=2"></noscript></head>') } : response)
    })
    await page.goto('/')
    await page.evaluate(() => {
      (window as { kept?: HTMLElement | undefined }).kept = [...document.head.querySelectorAll('noscript')].find(element => element.textContent?.includes('a=1&b=2'))
    })
    expect(await page.evaluate(() => (window as { kept?: HTMLElement | undefined }).kept !== undefined)).toBe(true)
    await page.click('a.about')
    await page.waitFor('h1', { text: 'About' })
    expect(await page.evaluate(() => [...document.head.querySelectorAll('noscript')].includes((window as { kept?: HTMLElement | undefined }).kept!))).toBe(true)
    await page.unroute()
    await page.close()
  })

  it('leaves the head of the page it reaches as a direct load of it writes it, the rules of the layout it left gone', async () => {
    const page = await browse(`${origin}/ga/pa`)

    await page.click('a.to-b')
    await page.waitFor('h1', { text: 'Page B' })

    const direct = await browse(`${origin}/gb/pb`)

    const rules = async (from: TestPage) => from.evaluate(() => [...document.head.children].filter(element => element.tagName === 'STYLE' || element.matches('link[rel="stylesheet"]')).map(element => element.outerHTML).toSorted())

    expect(await rules(page)).toEqual(await rules(direct))
    expect(await inlined(page)).toContain('.gb-mark')
    expect(await inlined(page)).not.toContain('.ga-mark')
    await direct.close()
    await page.close()
  })

  it('swaps the copy of the route it leaves for the one of the route it reaches before it paints, and the rules apply', async () => {
    const page = await browse(`${origin}/bulk`)

    const links = async () => page.evaluate(() => [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link => link.getAttribute('href')))
    const first = await links()

    expect(first).toHaveLength(1)
    expect(first[0]).toMatch(ROUTE_COPY)
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    await page.click('a.to-other')
    await page.waitFor('h1', { text: 'Other' })

    const second = await links()

    expect(second).toHaveLength(1)
    expect(second[0]).toMatch(ROUTE_COPY)
    expect(second[0]).not.toBe(first[0])
    expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('p')!).paddingTop)).toBe('6802px')
    await page.back()
    await page.waitFor('h1', { text: 'Bulk' })
    expect(await links()).toEqual(first)
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('p')!).paddingTop)).toBe('1802px')
    await page.close()
  })
})

describe.skipIf(!browserInstalled && (process.env.CI ?? '') === '')('lateStyles, in Chromium', () => {
  let server: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  let origin: string
  let appDir = ''

  beforeAll(async () => {
    ;({ dir: appDir, server, origin } = await startFixture({ LATE_STYLES: 'true' }))
  }, 120_000)

  afterAll(async () => {
    server?.kill()
    await server?.exited
    await rm(appDir, { recursive: true, force: true })
  })

  it('applies the whole stylesheet once the page is up, and the rules only it holds', async () => {
    const page = await browse(`${origin}/data`)

    await page.waitUntil(() => document.querySelector<HTMLLinkElement>('link[data-kay-rest]')?.media === 'all')
    await page.waitUntil(() => getComputedStyle(document.querySelector('.tone')!).boxShadow !== 'none')
    await page.close()
  })

  it('swaps pages with the whole stylesheet linked once', async () => {
    const page = await browse(`${origin}/`)

    await page.waitUntil(() => document.querySelector<HTMLLinkElement>('link[data-kay-rest]')?.media === 'all')
    await page.click('a.about')
    await page.waitFor('h1', { text: 'About' })
    expect(await page.evaluate(() => [...document.head.querySelectorAll<HTMLLinkElement>('link[data-kay-rest]')].map(link => link.media))).toEqual(['all'])
    // The shared stylesheet keeps its place after the page's own rules.
    expect(await page.evaluate(() => {
      const children = [...document.head.children]

      return children.findLastIndex(element => element.tagName === 'STYLE') < children.findIndex(element => element.matches('link[data-kay-rest]'))
    })).toBe(true)
    await page.close()
  })
})
