import type { KayConfig } from '../config'
import type { ClientBuild, PrerenderedPage } from './client'
import { mkdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { PRERENDERED_DIR, readManifest, writeManifest } from './client'
import { registerLoader } from './loader'
import { renderPage } from './render'
import { scanRoutes } from './routes'

// Renders every page whose server fence exports `prerender = true` into `.kay/client/pages`, listing them in the manifest the server boots from.
export async function prerenderPages(root: string, config: KayConfig, client: ClientBuild): Promise<number> {
  registerLoader(root)

  const manifest = await readManifest(root)

  if (!manifest)
    throw new Error('kay: no client build to add prerendered pages to; run buildClient first')

  const dir = join(root, '.kay', 'client', PRERENDERED_DIR)
  const pages: Record<string, PrerenderedPage> = {}

  for (const route of await scanRoutes(resolve(root, config.routes ?? 'src/routes'))) {
    // Read off the source first: a page that prerenders nothing is never imported, nor anything it imports.
    if (!await exportsPrerender(route.file) || (await import(route.file) as { prerender?: unknown }).prerender !== true)
      continue

    const file = relative(root, route.file)

    if (route.params.length > 0)
      throw new Error(`kay: ${file} takes params, so it has no single page to prerender`)

    // Guards run when the page is served, for whoever asks; the build renders what they let through.
    const response = await renderPage({ ...route, guards: [] }, { request: new Request(`http://localhost${route.pattern}`), params: {} }, client, { lang: config.lang, prefetch: config.prefetch, prerendering: true })

    if (response.status >= 500)
      throw new Error(`kay: prerendering ${file} failed with ${response.status}; the error is logged above`)

    const html = await response.text()
    const name = `${route.pattern === '/' ? 'index' : route.pattern.slice(1)}.html`
    const headers: Record<string, string> = {}

    for (const [header, value] of response.headers) {
      if (header !== 'set-cookie')
        headers[header] = value
    }

    await mkdir(join(dir, name, '..'), { recursive: true })
    await Bun.write(join(dir, name), html)
    pages[route.pattern] = { file: name, status: response.status, headers, etag: `"${Bun.hash(html).toString(36)}"` }
  }

  await writeManifest(root, { ...manifest, pages })
  client.pages = new Map(Object.entries(pages))

  return Object.keys(pages).length
}

async function exportsPrerender(file: string): Promise<boolean> {
  const source = await Bun.file(file).text()

  return analyzeServer(source, parseKay(source).server)?.exportNames.includes('prerender') ?? false
}
