import type { AppName } from './apps'
import { join } from 'node:path'

const BODY = /<body>([\s\S]*)<\/body>/
const COMMENT = /<!--[\s\S]*?-->/g
const HYDRATION_KEY = / (?:data-hk="[^"]*"|_hk=\S+?(?=[ >]))/g
const ISLAND_TAG = /<\/?kay-island[^>]*>/g

// The body as a browser shows it: hydration keys, markers and kay's island wrappers stripped.
export function visibleMarkup(html: string): string {
  return (BODY.exec(html)?.[1] ?? '').replace(COMMENT, '').replace(HYDRATION_KEY, '').replace(ISLAND_TAG, '')
}

// Renders a path in the app's own process and returns its visible markup.
export async function renderVisible(app: AppName, path: string): Promise<string> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'render.ts'), app, path], { stdout: 'pipe', stderr: 'inherit' })

  return visibleMarkup(await new Response(child.stdout).text())
}
