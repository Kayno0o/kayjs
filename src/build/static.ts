import type { KayConfig } from '../config'
import type { ClientBuild } from '../server/client'
import type { Redirects } from '../server/redirects'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import { pageHooks } from '../config'
import { feedPaths, projectCollections } from '../content/server'
import { projectPaths } from '../project'
import { joinBase } from '../runtime/base'
import { escape, escapeAttribute } from '../runtime/escape'
import { localePath, splitLocale, untranslatedPath } from '../runtime/i18n'
import { pages as servePages } from '../server'
import { basePath } from '../server/base'
import { PRERENDERED_DIR } from '../server/client'
import { compressPaths } from '../server/compress'
import { exportedEndpoints } from '../server/endpoints'
import { PUBLIC_ENV_PATH } from '../server/env'
import { faviconPaths } from '../server/favicon'
import { localeSettings } from '../server/i18n'
import { SERVICE_WORKER } from '../server/offline'
import { applyPageHooks, assetFiles } from '../server/page-hook'
import { publicFiles } from '../server/public'
import { routeMounts, scanEndpoints } from '../server/routes'
import { siteOrigin } from '../server/seo'
import { ROBOTS, SITEMAP } from '../server/sitemap'
import { outputDir } from './assets'

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

// What a static export cannot do, checked before anything is built.
export function refuseStaticConfig(config: KayConfig): void {
  if (config.i18n?.domains)
    throw new Error('kay: a static export is one directory for one host, so it cannot serve locales by domain; drop i18n.domains or deploy a server')
}

// Writes the whole site to `outdir`, as any static host serves it: every prerendered page, the browser build under `/_kay/`, the public files, the sitemap, feeds and favicons, `404.html`, and a page for each redirect.
// Each page goes in as `about.html` and `about/index.html`, which every host finds for `/about` and `/about/` alike, beside the compressed copies a host may send as they are.
export async function exportStatic(root: string, config: KayConfig, client: ClientBuild, outdir: string): Promise<StaticExport> {
  const out = resolve(outdir)

  refuseStaticConfig(config)
  await clear(root, out)

  const pagesDir = join(outputDir(root), PRERENDERED_DIR)
  const pages = [...client.pages]
  // What is written here rather than copied from the build, compressed once it is all in.
  const written: string[] = []

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

  const { public: publicDir, routes: routesDir } = projectPaths(root, config)

  if (existsSync(publicDir)) {
    await cp(publicDir, out, { recursive: true })
    written.push(...(await publicFiles(publicDir)).map(file => join(out, relative(publicDir, file.path))))
  }

  // What kay serves itself comes from the app, as a server would answer it.
  // The extensions' server plugins are left out, since nothing a static site serves runs them and one may open a database.
  const extensions = config.extensions?.map(({ server: _, ...extension }) => extension)
  const app = new Elysia().use(await servePages({ ...config, extensions, root, prebuilt: true, log: false, health: false, security: false, compress: false }))
  const fetched = [SERVICE_WORKER, ...config.site === undefined ? [] : [SITEMAP, ROBOTS], ...faviconPaths(config.favicon, config.manifest), ...config.publicEnv === undefined ? [] : [PUBLIC_ENV_PATH], ...(await projectCollections(root, config.content)).flatMap(collection => feedPaths(collection, config.i18n && localeSettings(config.i18n)).map(({ path }) => path)), ...(await exportedEndpoints(root, await scanEndpoints(routesDir, routeMounts(root, config.extensions)))).paths]

  for (const path of fetched) {
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

  const settings = config.i18n && localeSettings(config.i18n)

  // With every locale prefixed, a path without one has no file of its own: it goes to the default locale's.
  // A page a locale translates has none at its untranslated path either, which goes to the translated one.
  if (settings && !settings.hosts) {
    for (const [path] of pages) {
      const { locale, path: own } = splitLocale(settings, path)

      if (locale === undefined)
        continue

      const page = untranslatedPath(settings, own, locale)

      if (page !== own)
        written.push(...await writeRefresh(out, localePath({ ...settings, paths: undefined }, page, locale), joinBase(base, path), origin))

      if (settings.prefixDefault && locale === settings.defaultLocale)
        written.push(...await writeRefresh(out, page, joinBase(base, path), origin))
    }
  }

  await compressPaths(written)
  await Bun.write(join(out, MARKER), '')

  return { pages: pages.length, files: written.length }
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
