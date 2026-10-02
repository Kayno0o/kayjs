import { existsSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { findKayFiles } from '../build/files'

export interface Route {
  // Elysia path pattern: `/todos/:id`, `/docs/*`.
  pattern: string
  file: string
  params: string[]
  // The parameter a `[...name].kay` file binds to Elysia's `*`.
  catchAll?: string
  // `_layout.kay` files wrapping the page, outermost first.
  layouts: string[]
}

const DYNAMIC_SEGMENT = /^\[(\.\.\.)?([A-Z_$][\w$]*)\]$/i
const KAY_EXTENSION = /\.kay$/
const LAYOUT = '_layout.kay'

// The route a file under the routes directory serves; files starting with `_` (layouts, partials) serve none.
export function routeOf(routesDir: string, file: string): Omit<Route, 'layouts'> | undefined {
  if (basename(file).startsWith('_'))
    return undefined

  const segments = relative(routesDir, file).replace(KAY_EXTENSION, '').split(sep)

  if (segments.at(-1) === 'index')
    segments.pop()

  const params: string[] = []
  let catchAll: string | undefined
  const parts = segments.map((segment) => {
    const match = DYNAMIC_SEGMENT.exec(segment)

    if (!match)
      return segment

    params.push(match[2]!)

    if (!match[1])
      return `:${match[2]}`

    catchAll = match[2]

    return '*'
  })

  return { pattern: `/${parts.join('/')}`, file, params, catchAll }
}

export async function scanRoutes(routesDir: string): Promise<Route[]> {
  if (!existsSync(routesDir))
    return []

  const routes: Route[] = []

  for (const file of await findKayFiles(routesDir)) {
    const route = routeOf(routesDir, file)

    if (route)
      routes.push({ ...route, layouts: layoutsOf(routesDir, file) })
  }

  return routes
}

function layoutsOf(routesDir: string, file: string): string[] {
  const layouts: string[] = []

  for (let dir = dirname(file); dir.startsWith(routesDir); dir = dirname(dir)) {
    const layout = join(dir, LAYOUT)

    if (existsSync(layout))
      layouts.unshift(layout)

    if (dir === routesDir)
      break
  }

  return layouts
}
