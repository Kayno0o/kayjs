import type { Browser } from 'playwright-core'
import type { AppName } from './apps'
import { join } from 'node:path'
import { APPS } from './apps'
import { serve, tableRows } from './browser'

const BODY = /<body>([\s\S]*)<\/body>/
const COMMENT = /<!--[\s\S]*?-->/g
const HYDRATION_KEY = / (?:data-hk="[^"]*"|_hk=\S+?(?=[ >]))/g
const ISLAND_TAG = /<\/?slot(?: [^>]*)?>/g
const SCRIPT = String.raw`<script[^>]*>[\s\S]*?<\/script>`
// What a framework adds to the body that the page does not show: Astro wraps each island and puts its loader before the first, Next streams its component payload in scripts and leaves an empty metadata outlet, Nuxt wraps the app in its mount point, then adds a teleport target and its payload.
const FRAMEWORK_MARKUP: Partial<Record<AppName, RegExp>> = {
  astro: new RegExp(`${SCRIPT}|<style>[\\s\\S]*?<\\/style>|<\\/?astro-island[^>]*>`, 'g'),
  next: new RegExp(`${SCRIPT}|<div hidden=""><\\/div>`, 'g'),
  nuxt: new RegExp(`${SCRIPT}|^<div id="__nuxt">|<\\/div><div id="teleports"><\\/div>`, 'g'),
}
// What a framework adds to the rows it creates in the browser that shows nothing: Vue leaves an empty class on a row its `:class` binding does not select.
const FRAMEWORK_ROWS: Partial<Record<AppName, RegExp>> = {
  nuxt: / class=""/g,
}

export const PATHS = ['/', '/table']

// Markup as a browser shows it: hydration keys and markers stripped.
export function visibleRows(html: string): string {
  return html.replace(COMMENT, '').replace(HYDRATION_KEY, '')
}

// The body as a browser shows it, kay's island wrappers and the app's own framework markup stripped too.
export function visibleMarkup(html: string, app: AppName): string {
  const body = visibleRows(BODY.exec(html)?.[1] ?? '').replace(ISLAND_TAG, '')
  const extra = FRAMEWORK_MARKUP[app]

  return extra ? body.replace(extra, '') : body
}

// What each app server-renders for a path, in `APPS` order, each in its own process.
export async function serverMarkup(path: string): Promise<string[]> {
  return Promise.all(APPS.map(async app => visibleMarkup(await serverHtml(app, path), app)))
}

// The document an app serves for a path, rendered in a process of its own.
export async function serverHtml(app: AppName, path: string): Promise<string> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'render.ts'), app, path], { stdout: 'pipe', stderr: 'inherit', env: { ...process.env, NODE_ENV: 'production' } })
  const [html, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  if (code !== 0)
    throw new Error(`${app} failed to render ${path}`)

  return html
}

// The rows each app's table renders in the browser after creating 1,000 of them, in `APPS` order.
export async function clientRows(browser: Browser): Promise<string[]> {
  const rows: string[] = []

  for (const app of APPS) {
    const server = await serve(app)

    try {
      const created = await tableRows(browser, server.url)
      const extra = FRAMEWORK_ROWS[app]

      rows.push(extra ? created.replace(extra, '') : created)
    }
    finally {
      server.stop()
    }
  }

  return rows
}
