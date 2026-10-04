import type { KayConfig } from '../config'
import type { ClientBuild } from '../server/client'
import type { Redirects } from '../server/redirects'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import { projectCollections } from '../content/server'
import { joinBase } from '../runtime/base'
import { escape, escapeAttribute } from '../runtime/escape'
import { localePath } from '../runtime/i18n'
import { pages as servePages } from '../server'
import { basePath } from '../server/base'
import { PRERENDERED_DIR } from '../server/client'
import { FAVICON_PATHS } from '../server/favicon'
import { localeSettings } from '../server/i18n'
import { ROBOTS, SITEMAP } from '../server/sitemap'

// Left in the directory a static export writes, so a later export knows it may clear it, and never clears one it did not write.
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

// Writes the whole site to `outdir`, as any static host serves it: every prerendered page, the browser build under `/_kay/`, the public files, the sitemap, feeds and favicons, `404.html`, and a page for each redirect.
// Each page goes in as `about.html` and `about/index.html`, which every host finds for `/about` and `/about/` alike, beside the compressed copies a host may send as they are.
export async function exportStatic(root: string, config: KayConfig, client: ClientBuild, outdir: string): Promise<StaticExport> {
  const out = resolve(outdir)

  if (config.i18n?.domains)
    throw new Error('kay: a static export is one directory for one host, so it cannot serve locales by domain; drop i18n.domains or deploy a server')

  await clear(root, out)

  const pagesDir = join(root, '.kay', 'client', PRERENDERED_DIR)
  const pages = [...client.pages]
  let files = 0

  await cp(client.dir, join(out, '_kay'), { recursive: true, filter: source => !SOURCE_MAP.test(source) })

  for (const [path, page] of pages) {
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

  const publicDir = resolve(root, config.publicDir ?? 'public')

  if (existsSync(publicDir))
    await cp(publicDir, out, { recursive: true })

  // What kay serves itself comes from the app, as a server would answer it.
  const app = new Elysia().use(await servePages({ ...config, root, prebuilt: true, log: false, health: false, security: false, compress: false }))
  const fetched = [...config.site === undefined ? [] : [SITEMAP, ROBOTS], ...config.favicon === undefined ? [] : FAVICON_PATHS, ...(await projectCollections(root, config.content)).flatMap(collection => collection.options.feed ? [collection.options.feed.path] : [])]

  for (const path of fetched) {
    const response = await app.handle(new Request(`http://localhost${path}`))

    if (response.ok) {
      await Bun.write(join(out, decodeURIComponent(path)), await response.arrayBuffer())
      files++
    }
  }

  const missing = await app.handle(new Request(`http://localhost${MISSING}`))

  if (missing.status === 404 && missing.headers.get('content-type')?.startsWith('text/html')) {
    await Bun.write(join(out, '404.html'), await missing.text())
    files++
  }

  const base = basePath(config.base)

  files += await writeRedirects(out, config.redirects ?? {}, base)

  // With every locale prefixed, a path without one has no file of its own: it goes to the default locale's.
  if (config.i18n?.prefixDefault) {
    const settings = localeSettings(config.i18n)
    const prefix = `/${settings.defaultLocale}`

    for (const [path] of pages.filter(([path]) => path === prefix || path.startsWith(`${prefix}/`)))
      files += await writeRefresh(out, path.slice(prefix.length) || '/', joinBase(base, localePath(settings, path.slice(prefix.length) || '/', settings.defaultLocale)))
  }

  await Bun.write(join(out, MARKER), '')

  return { pages: pages.length, files }
}

// A directory kay may write to: never the project or what holds it, and one with files in it only when an export wrote them.
async function clear(root: string, out: string): Promise<void> {
  if (out === root || root.startsWith(out + sep) || out.startsWith(join(root, 'src') + sep) || out === join(root, 'src'))
    throw new Error(`kay: a static export into ${relative(process.cwd(), out) || '.'} would write over the project; give it a directory of its own, such as dist`)

  if (existsSync(out) && (await readdir(out)).length > 0 && !existsSync(join(out, MARKER)))
    throw new Error(`kay: ${relative(process.cwd(), out)} holds files a static export did not write; empty it or give another directory`)

  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
}

// The files a page path is written to: `/` as `index.html`, any other both ways.
function pageFiles(path: string): string[] {
  const name = decodeURIComponent(path).slice(1)

  return name === '' ? ['index.html'] : [`${name}.html`, join(name, 'index.html')]
}

// A static host answers no redirect, so each one without params becomes a page sending the browser on; all of them also go to `_redirects`, which hosts such as Netlify and Cloudflare Pages read.
async function writeRedirects(out: string, redirects: Redirects, base: string): Promise<number> {
  const entries = Object.entries(redirects).map(([from, target]) => ({ from, ...typeof target === 'string' ? { to: target, permanent: true } : { to: target.to, permanent: target.permanent ?? true } }))
  let written = 0

  if (entries.length === 0)
    return written

  for (const { from, to } of entries.filter(entry => !PARAM_OR_REST.test(entry.from)))
    written += await writeRefresh(out, from, joinBase(base, to))

  const lines = entries.map(({ from, to, permanent }) => `${joinBase(base, from)} ${joinBase(base, to).replace(REST, ':splat')} ${permanent ? 301 : 302}`)

  await Bun.write(join(out, '_redirects'), `${lines.join('\n')}\n`)

  return written + 1
}

// A page at `from` that sends the browser to `to` at once, telling search engines the page that counts.
async function writeRefresh(out: string, from: string, to: string): Promise<number> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${escapeAttribute(to)}"><link rel="canonical" href="${escapeAttribute(to)}"><title>${escape(to)}</title></head><body><a href="${escapeAttribute(to)}">${escape(to)}</a></body></html>`

  for (const target of pageFiles(from)) {
    if (existsSync(join(out, target)))
      continue

    await mkdir(dirname(join(out, target)), { recursive: true })
    await Bun.write(join(out, target), html)
  }

  return 1
}
