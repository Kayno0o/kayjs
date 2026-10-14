import type { KayConfig } from '../config'
import type { Project } from '../project'
import type { ClientBuild } from '../server/client'
import type { Redirects } from '../server/redirects'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import { pageHooks } from '../config'
import { resolveProject } from '../project'
import { joinBase } from '../runtime/base'
import { escape, escapeAttribute } from '../runtime/escape'
import { localePath, splitLocale, untranslatedPath } from '../runtime/i18n'
import { pagesApp } from '../server/app'
import { basePath } from '../server/base'
import { PRERENDERED_DIR } from '../server/client'
import { compressPaths } from '../server/compress'
import { localeSettings } from '../server/i18n'
import { applyPageHooks, assetFiles } from '../server/page-hook'
import { publicFiles, servedPublicly } from '../server/public'
import { withoutSlash } from '../server/routes'
import { siteOrigin } from '../server/seo'

// Left in the directory a static export writes, so a later export knows it may clear it, and never clears one it did not write.
interface App {
  handle: (request: Request) => Promise<Response>
}

const MARKER = '.kay-static'
const COPIES = ['.br', '.gz']
const SOURCE_MAP = /\.map$/
const PARAM_OR_REST = /(?:^|\/)(?::|\*)/
const REST = /\*/
// Asked of the app to render its own 404 page; no page serves it.
const MISSING = '/_kay-static-missing'

export interface StaticExport {
  pages: number
  files: number
}

// What a static export cannot do, checked before anything is built.
export function refuseStaticConfig(config: KayConfig): void {
  if (config.i18n?.domains)
    throw new Error('kay: a static export is one directory for one host, so it cannot serve locales by domain; drop i18n.domains or deploy a server')

  if (config.images?.resolve)
    throw new Error('kay: a static export has no image route to resize what images.resolve looks up on each request; drop images.resolve or deploy a server')
}

// Writes the whole site to `outdir`, as any static host serves it: every prerendered page, the browser build under `/_kay/`, the public files, the sitemap, feeds and favicons, `404.html`, and a page for each redirect.
// Each page goes in as `about.html` and `about/index.html`, which every host finds for `/about` and `/about/` alike, beside the compressed copies a host may send as they are.
export async function exportStatic(project: Project, client: ClientBuild, outdir: string): Promise<StaticExport> {
  const { root, config, paths: { public: publicDir, output } } = project
  const out = resolve(outdir)

  refuseStaticConfig(config)
  await clear(root, out)

  const pagesDir = join(output, PRERENDERED_DIR)
  const built = [...client.pages]
  // What is written here rather than copied from the build, compressed once it is all in.
  const written: string[] = []

  await cp(client.dir, join(out, '_kay'), { recursive: true, filter: source => !SOURCE_MAP.test(source) })

  for (const [path, page] of built) {
    for (const target of pageFiles(path)) {
      for (const copy of ['', ...COPIES]) {
        const source = join(pagesDir, `${page.file}${copy}`)

        if (existsSync(source)) {
          await mkdir(dirname(join(out, `${target}${copy}`)), { recursive: true })
          await cp(source, join(out, `${target}${copy}`))
        }
      }
    }
  }

  if (existsSync(publicDir)) {
    await cp(publicDir, out, { recursive: true, filter: source => servedPublicly(relative(publicDir, source), true) })
    written.push(...(await publicFiles(publicDir)).map(file => join(out, relative(publicDir, file.path))))
  }

  // What kay serves itself comes from the app, as a server would answer it.
  // The extensions' server plugins are left out, since nothing a static site serves runs them and one may open a database.
  const extensions = config.extensions?.map(({ server: _, ...extension }) => extension)
  const pages = await pagesApp(resolveProject(root, { ...config, extensions, log: false, health: false, security: false, compress: false }, project.mode), async () => client, true)
  const app = new Elysia().use(pages.app)

  for (const path of await pages.served.exported()) {
    const response = await app.handle(new Request(`http://localhost${path}`))

    if (!response.ok)
      throw new Error(`kay: ${path} answered ${response.status} while exporting it; the error is logged above`)

    const file = join(out, decodeURIComponent(path))

    await Bun.write(file, await response.arrayBuffer())
    written.push(file)
  }

  const missing = await app.handle(new Request(`http://localhost${MISSING}`))

  // Rendered here rather than prerendered, so it goes through the page hooks as it is written.
  if (missing.status === 404 && missing.headers.get('content-type')?.startsWith('text/html')) {
    const files = assetFiles({ clientDir: client.dir, publicDir, base: basePath(config.base), aspects: config.images?.aspects })

    await Bun.write(join(out, '404.html'), await applyPageHooks(pageHooks(config.extensions), '/404.html', await missing.text(), files))
    written.push(join(out, '404.html'))
  }

  const base = basePath(config.base)
  const origin = config.site === undefined ? '' : siteOrigin(config.site)

  written.push(...await writeRedirects(out, config.redirects ?? {}, base, origin))

  written.push(...await writeLocaleRedirects(app, out, config, built.map(([path]) => path), base, origin))

  await compressPaths(written)

  return { pages: built.length, files: written.length }
}

// The paths the server sends to a page in its locale, each written as a page sending there: with every locale prefixed, the page's path without its prefix, and the path a locale translates, untranslated.
async function writeLocaleRedirects(app: App, out: string, config: KayConfig, paths: string[], base: string, origin: string): Promise<string[]> {
  const settings = config.i18n && localeSettings(config.i18n)

  if (!settings || settings.hosts)
    return []

  const sources = new Set<string>()
  const written: string[] = []

  for (const path of paths) {
    const { locale, path: own } = splitLocale(settings, path)

    if (locale === undefined)
      continue

    const page = untranslatedPath(settings, own, locale)

    for (const source of [localePath({ ...settings, paths: undefined }, page, locale), page]) {
      if (withoutSlash(source) !== withoutSlash(path))
        sources.add(source)
    }
  }

  for (const source of sources) {
    const location = await localeRedirect(app, source, base)

    if (location !== undefined)
      written.push(...await writeRefresh(out, source, location, origin))
  }

  return written
}

// Where the server sends a first visit to the path, which goes to the default locale. Under `trailingSlash`, its slash redirects come before and after that one: the page is written to send where they settle.
async function localeRedirect(app: App, source: string, base: string): Promise<string | undefined> {
  const redirected = async (path: string) => {
    const response = await app.handle(new Request(`http://localhost${path}`))
    const location = response.headers.get('location')

    return response.status >= 300 && response.status < 400 && location !== null ? location : undefined
  }
  const sitePath = (location: string | undefined) => location?.startsWith(`${base}/`) === true ? location.slice(base.length) : undefined
  const slashOnly = (from: string | undefined, to: string | undefined) => from !== undefined && to !== undefined && to !== from && withoutSlash(to) === withoutSlash(from)
  const first = await redirected(source)
  const location = slashOnly(source, sitePath(first)) ? await redirected(sitePath(first)!) : first
  const target = sitePath(location)
  const settled = target === undefined ? undefined : await redirected(target)

  return slashOnly(target, sitePath(settled)) ? settled : location
}

// A directory kay may write to: never the project or what holds it, and one with files in it only when an export wrote them.
async function clear(root: string, out: string): Promise<void> {
  if (out === root || root.startsWith(out + sep) || out.startsWith(join(root, 'src') + sep) || out === join(root, 'src'))
    throw new Error(`kay: a static export into ${relative(process.cwd(), out) || '.'} would write over the project; give it a directory of its own, such as dist`)

  if (existsSync(out) && (await readdir(out)).length > 0 && !existsSync(join(out, MARKER)))
    throw new Error(`kay: ${relative(process.cwd(), out)} holds files a static export did not write; empty it or give another directory`)

  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  // Marked first, so an export failing halfway leaves a directory the next one may clear.
  await Bun.write(join(out, MARKER), '')
}

// The files a page path is written to: `/` as `index.html`, any other both ways.
function pageFiles(path: string): string[] {
  const name = decodeURIComponent(path).slice(1)

  return name === '' ? ['index.html'] : [`${name}.html`, join(name, 'index.html')]
}

// A static host answers no redirect, so each one without params becomes a page sending the browser on; all of them also go to `_redirects`, which hosts such as Netlify and Cloudflare Pages read.
async function writeRedirects(out: string, redirects: Redirects, base: string, origin: string): Promise<string[]> {
  const entries = Object.entries(redirects).map(([from, target]) => ({ from, ...typeof target === 'string' ? { to: target, permanent: true } : { to: target.to, permanent: target.permanent ?? true } }))

  if (entries.length === 0)
    return []

  const written: string[] = []

  for (const { from, to } of entries.filter(entry => !PARAM_OR_REST.test(entry.from)))
    written.push(...await writeRefresh(out, from, joinBase(base, to), origin))

  const lines = entries.map(({ from, to, permanent }) => `${joinBase(base, from)} ${joinBase(base, to).replace(REST, ':splat')} ${permanent ? 301 : 302}`)

  await Bun.write(join(out, '_redirects'), `${lines.join('\n')}\n`)

  return [...written, join(out, '_redirects')]
}

// A page at `from` that sends the browser to `to` at once, telling search engines the page that counts; a file a page already took is left alone.
async function writeRefresh(out: string, from: string, to: string, origin: string): Promise<string[]> {
  const canonical = to.startsWith('/') && !to.startsWith('//') ? origin + to : to
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${escapeAttribute(to)}"><link rel="canonical" href="${escapeAttribute(canonical)}"><title>${escape(to)}</title></head><body><a href="${escapeAttribute(to)}">${escape(to)}</a></body></html>`
  const written: string[] = []

  for (const target of pageFiles(from)) {
    if (existsSync(join(out, target)))
      continue

    await mkdir(dirname(join(out, target)), { recursive: true })
    await Bun.write(join(out, target), html)
    written.push(join(out, target))
  }

  return written
}
