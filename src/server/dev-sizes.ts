import type { StoredReport } from '../build/report'
import type { RouteMatch } from './actions'
import type { ServedRoute } from './guards'
import type { RouteTable } from './route-table'
import { stat } from 'node:fs/promises'
import { Elysia } from 'elysia'
import { readStoredReport } from '../build/report'
import { isCrossSite } from './actions'
import { routerPath } from './base'

const HEADER = 'x-kay-dev'

// What the last `kay build` measured for a page, for the Performance tab to set beside the dev sizes.
export interface DevSizes {
  route: string
  js: number
  css: number
  // The scripts are what the route's components can load, as no page of it was prerendered.
  estimated: boolean
  // A static export, not a server build.
  exported: boolean
  // When the report was written.
  built: number
}

// A route entry a report may hold, which a file edited or written by another version may not.
function sized(entry: StoredReport['routes'][string] | undefined): boolean {
  return entry !== undefined && entry !== null && Number.isFinite(entry.js) && Number.isFinite(entry.css)
}

export interface SizesSite {
  table: RouteTable
  match: RouteMatch
  base: string
  // The files `kay build` keeps its reports in: a server build's, then a static export's.
  reports: [server: string, exported: string]
}

// The server's side of the Performance tab's production sizes: the route serving the page, as the router reads it, looked up in the report the last build kept under `.kay`. Only the page's path is read, from the dev tool, and nothing is built or rendered.
// Elysia's own router over the paths the pages are served at, which answers with the path matching: the order the real router tries them in, a static segment before a param and a param before a catch-all.
const routers = new WeakMap<RouteTable, Elysia>()

async function routeOf(table: RouteTable, match: RouteMatch, path: string): Promise<ServedRoute | undefined> {
  let router = routers.get(table)

  if (router === undefined) {
    router = new Elysia()

    for (const served of table.paths.keys())
      router.get(served, () => served)

    routers.set(table, router)
  }

  let served: string

  try {
    const response = await router.handle(new Request(`http://localhost${path}`))

    if (!response.ok)
      return undefined

    served = await response.text()
  }
  catch {
    return undefined
  }

  // The pages of that path in any locale, in the order they are tried; the first that reads the path as its own.
  for (const { candidates } of table.paths.get(served)?.values() ?? []) {
    const found = candidates.find(candidate => match.posted(candidate.route, path) !== undefined)

    if (found !== undefined)
      return found.route
  }

  return undefined
}

export async function devSizes(request: Request, { table, match, base, reports }: SizesSite): Promise<Response> {
  if (request.headers.get(HEADER) === null || isCrossSite(request))
    return new Response(null, { status: 403 })

  const path = new URL(request.url).searchParams.get('path')

  if (path === null)
    return new Response(null, { status: 400 })

  const read = async (file: string, exported: boolean): Promise<{ stored: StoredReport, built: number } | undefined> => {
    const stored = await readStoredReport(file, exported)

    try {
      return stored === undefined ? undefined : { stored, built: (await stat(file)).mtimeMs }
    }
    catch {
      return undefined
    }
  }
  const found = (await Promise.all([read(reports[0], false), read(reports[1], true)])).filter(report => report !== undefined)

  if (found.length === 0)
    return Response.json({ sizes: undefined })

  const route = await routeOf(table, match, routerPath(path, base))
  // The newest of the reports that know the route.
  const latest = found.filter(report => route !== undefined && sized(report.stored.routes?.[route.pattern])).sort((a, b) => b.built - a.built)[0]

  if (route === undefined || latest === undefined)
    return Response.json({ sizes: undefined })

  const { js, css, estimated } = latest.stored.routes[route.pattern]!

  return Response.json({ sizes: { route: route.pattern, js, css, estimated: estimated === true, exported: latest.stored.exported, built: latest.built } satisfies DevSizes })
}
