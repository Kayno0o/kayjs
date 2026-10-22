import type { Elysia } from 'elysia'
import type { MetricsConfig, ProxyConfig } from '../config'
import process from 'node:process'
import { cacheReads, jobRuns, pageRoutes } from '../runtime/counters'
import { kayLog } from '../runtime/log'
import { routerPath } from './base'
import { pathOf, statusOf } from './log'
import { fromPrivateNetwork } from './protection'
import { sameText } from './seal'

export const METRICS_PATH = '/metrics'
const TOKEN_VARIABLE = 'KAY_METRICS_TOKEN'
// Seconds, the Prometheus client libraries' default buckets.
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
// The most method, route and status series kept, so a route per visitor cannot grow the page; past it the route reads `other`.
const MAX_SERIES = 500
// What a proxy in front adds to a request it forwards: a request carrying one did not come straight from a collector.
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via', 'cf-connecting-ip']
const BEARER = /^bearer /i
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const BACKSLASH = /\\/g
const QUOTE = /"/g
const NEWLINE = /\n/g

interface Series {
  count: number
  sum: number
  buckets: number[]
}

// The bearer token the scrape must carry when `KAY_METRICS_TOKEN` is set.
function metricsToken(): string | undefined {
  const token = process.env[TOKEN_VARIABLE]?.trim()

  return token === undefined || token === '' ? undefined : token
}

// Whether a request may read the metrics: with `KAY_METRICS_TOKEN` set, the one carrying it from anywhere, else only one that reached the socket from this machine or a private network and carries no mark of a proxy, so a reverse proxy forwarding the path for a visitor is refused.
export function metricsAllowed(request: Request, address: string | undefined, proxy?: ProxyConfig): boolean {
  const token = metricsToken()

  if (token !== undefined) {
    const given = request.headers.get('authorization')

    return given !== null && BEARER.test(given) && sameText(given.slice('Bearer '.length), token)
  }

  if (address === undefined || !fromPrivateNetwork(address))
    return false

  return !FORWARDED_HEADERS.some(name => request.headers.has(name)) && [proxy?.header, proxy?.key].every(name => name === undefined || !request.headers.has(name))
}

function labelled(value: string): string {
  return value.replace(BACKSLASH, '\\\\').replace(QUOTE, '\\"').replace(NEWLINE, '\\n')
}

// Counts the requests the server answered and writes them, with the jobs, the cache and the open connections, as the Prometheus text format.
export function serveMetrics(app: Elysia, options: { path: string, base: string, proxy: ProxyConfig | undefined, health: string | undefined, holds: () => boolean, connections: () => number }): void {
  const started = Date.now()
  const requests = new Map<string, number>()
  const durations = new Map<string, Series>()
  const timing = new WeakMap<Request, { at: number, answered?: number }>()

  const asked = (request: Request): boolean => {
    if (!options.holds() || (request.method !== 'GET' && request.method !== 'HEAD'))
      return false

    const pathname = pathOf(request.url)

    // A trailing slash is the same route, as Elysia routes it, and the path is read with or without the base a proxy keeps.
    return [pathname, routerPath(pathname, options.base)].some(path => path === options.path || path === `${options.path}/`)
  }

  const lines = (): string => {
    const out: string[] = []
    const put = (name: string, help: string, type: string) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)

    put('kay_http_requests_total', 'Requests answered, by method, route and status.', 'counter')

    for (const [key, count] of requests)
      out.push(`kay_http_requests_total${key} ${count}`)

    put('kay_http_request_duration_seconds', 'Time to answer a request, by method and route.', 'histogram')

    for (const [key, series] of durations) {
      const inner = key.slice(1, -1)

      for (const [index, bound] of BUCKETS.entries()) {
        out.push(`kay_http_request_duration_seconds_bucket{${inner},le="${bound}"} ${series.buckets[index]}`)
      }
      out.push(`kay_http_request_duration_seconds_bucket{${inner},le="+Inf"} ${series.count}`, `kay_http_request_duration_seconds_sum{${inner}} ${series.sum}`, `kay_http_request_duration_seconds_count{${inner}} ${series.count}`)
    }

    put('kay_job_runs_total', 'Scheduled runs, by schedule and how each ended.', 'counter')

    for (const [label, runs] of jobRuns) {
      for (const result of ['ok', 'failed', 'skipped'] as const)
        out.push(`kay_job_runs_total{schedule="${labelled(label)}",result="${result}"} ${runs[result]}`)
    }

    put('kay_cache_reads_total', 'Cached values read, by whether the value was there already.', 'counter')
    out.push(`kay_cache_reads_total{result="hit"} ${cacheReads.hit}`, `kay_cache_reads_total{result="miss"} ${cacheReads.miss}`)
    put('kay_live_connections', 'Live event streams open now.', 'gauge')
    out.push(`kay_live_connections ${options.connections()}`)
    put('kay_process_resident_memory_bytes', 'Resident memory of the server process.', 'gauge')
    out.push(`kay_process_resident_memory_bytes ${process.memoryUsage().rss}`)
    put('kay_process_uptime_seconds', 'Seconds since the server started.', 'gauge')
    out.push(`kay_process_uptime_seconds ${Math.round((Date.now() - started) / 1000)}`)

    return `${out.join('\n')}\n`
  }

  // Answered as the request arrives, before routing, like the health route, so no extension's hook stands between a collector and the answer.
  app.onRequest(({ request, server }) => {
    if (!asked(request)) {
      // The health route is polled every few seconds and says nothing of the site.
      if (pathOf(request.url) !== options.health)
        timing.set(request, { at: performance.now() })

      return undefined
    }

    if (!metricsAllowed(request, (server)?.requestIP(request)?.address, options.proxy))
      return new Response('Forbidden\n', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })

    return new Response(request.method === 'HEAD' ? null : lines(), { headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' } })
  })

  app.mapResponse({ as: 'global' }, ({ request }) => {
    const time = timing.get(request)

    if (time)
      time.answered = performance.now()
  })

  app.onAfterResponse({ as: 'global' }, ({ request, set, responseValue, route }) => {
    const time = timing.get(request)

    if (!time)
      return

    const seconds = ((time.answered ?? performance.now()) - time.at) / 1000
    const method = METHODS.has(request.method) ? request.method : 'OTHER'
    const labels = (name: string) => `{method="${method}",route="${labelled(name)}"`
    const matched = pageRoutes.get(request) ?? route
    let name = typeof matched === 'string' && matched !== '' ? matched : 'unmatched'

    if (!durations.has(`${labels(name)}}`) && durations.size >= MAX_SERIES)
      name = 'other'

    const key = `${labels(name)}}`
    const series = durations.get(key) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) }

    series.count++
    series.sum += seconds
    for (const [index, bound] of BUCKETS.entries()) {
      if (seconds <= bound)
        series.buckets[index]!++
    }
    durations.set(key, series)

    const counted = `${labels(name)},status="${statusOf(responseValue, set)}"}`

    // Statuses are few, but a cap keeps the page bounded whatever an app answers.
    if (requests.has(counted) || requests.size < MAX_SERIES * 4)
      requests.set(counted, (requests.get(counted) ?? 0) + 1)
  })
}

// A proxy in front and no token: a proxy on this host that forwards the path without a mark of its own reads as a collector.
export function warnMetricsOpen(proxy: ProxyConfig | undefined): void {
  if (proxy !== undefined && metricsToken() === undefined)
    kayLog('warn', `metrics is read by any request from this machine or a private network that carries no proxy mark, and a proxy is set: do not forward its path, or set ${TOKEN_VARIABLE} so only a request with the token is answered`)
}

export function metricsOf(setting: boolean | MetricsConfig | undefined): MetricsConfig | undefined {
  if (setting === undefined || setting === false)
    return undefined

  return setting === true ? {} : setting
}
