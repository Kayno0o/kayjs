import type { Browser } from 'playwright-core'
import type { AppName } from './apps'
import { join } from 'node:path'
import { APPS } from './apps'
import { serve, tableRows } from './browser'

const BODY = /<body>([\s\S]*)<\/body>/
const COMMENT = /<!--[\s\S]*?-->/g
const HYDRATION_KEY = / (?:data-hk="[^"]*"|_hk=\S+?(?=[ >]))/g
const ISLAND_TAG = /<\/?slot(?: [^>]*)?>/g

export const PATHS = ['/', '/table']

// Markup as a browser shows it: hydration keys and markers stripped.
export function visibleRows(html: string): string {
  return html.replace(COMMENT, '').replace(HYDRATION_KEY, '')
}

// The body as a browser shows it, kay's island wrappers stripped too.
export function visibleMarkup(html: string): string {
  return visibleRows(BODY.exec(html)?.[1] ?? '').replace(ISLAND_TAG, '')
}

// What each app server-renders for a path, in `APPS` order, each in its own process.
export async function serverMarkup(path: string): Promise<string[]> {
  return Promise.all(APPS.map(async app => visibleMarkup(await serverHtml(app, path))))
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
      rows.push(await tableRows(browser, server.url))
    }
    finally {
      server.stop()
    }
  }

  return rows
}
