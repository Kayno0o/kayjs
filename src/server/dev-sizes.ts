import type { StoredReport } from '../build/report'
import type { RouteMatch } from './actions'
import type { ServedRoute } from './guards'
import { stat } from 'node:fs/promises'
import { readStoredReport } from '../build/report'
import { isCrossSite } from './actions'
import { routerPath } from './base'

const HEADER = 'x-kay-dev'
const PARAM = /[:*]/

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

export interface SizesSite {
  routes: ServedRoute[]
  match: RouteMatch
  base: string
  // The files `kay build` keeps its reports in: a server build's, then a static export's.
  reports: [server: string, exported: string]
}

// The server's side of the Performance tab's production sizes: the route serving the page, as the router reads it, looked up in the report the last build kept under `.kay`. Only the page's path is read, from the dev tool, and nothing is built or rendered.
export async function devSizes(request: Request, { routes, match, base, reports }: SizesSite): Promise<Response> {
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

  // A page whose pattern names no param wins over one that does, as the router has it.
  const served = routerPath(path, base)
  const route = routes.toSorted((a, b) => Number(PARAM.test(a.pattern)) - Number(PARAM.test(b.pattern))).find(candidate => match.posted(candidate, served) !== undefined)
  // The newest of the reports that know the route.
  const latest = found.filter(report => route !== undefined && report.stored.routes[route.pattern] !== undefined).sort((a, b) => b.built - a.built)[0]

  if (route === undefined || latest === undefined)
    return Response.json({ sizes: undefined })

  const { js, css, estimated } = latest.stored.routes[route.pattern]!

  return Response.json({ sizes: { route: route.pattern, js, css, estimated: estimated === true, exported: latest.stored.exported, built: latest.built } satisfies DevSizes })
}
