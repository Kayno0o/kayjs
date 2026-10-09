import { Elysia } from 'elysia'
import { pages } from 'kay/server'
import { measure } from 'mitata'

// What kay's own hooks cost a request: the health route with the stock hooks, with one of them off, or as a bare Elysia route. `bun bench/hooks-probe.ts <variant>`
const VARIANTS: Record<string, object> = {
  stock: {},
  nolog: { log: false },
  nocompress: { compress: false },
  nosecurity: { security: false },
  none: { log: false, compress: false, security: false },
}
const variant = Bun.argv[2] ?? 'stock'
let logged = 0
const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
const app = variant === 'bare'
  ? new Elysia().get('/_kay/health', () => new Response('ok', { headers }))
  : await pages({ root: `${import.meta.dir}/apps/kay`, minify: true, log: () => logged++, compress: true, ...VARIANTS[variant] })

async function request(): Promise<string> {
  const response = await app.handle(new Request('http://localhost/_kay/health', { headers: { 'accept-encoding': 'br, gzip' } }))

  return response.text()
}

await request()
const stats = await measure(request, { min_cpu_time: 2e9 })

console.log(variant.padEnd(12), `${(stats.avg / 1000).toFixed(2)} µs`, logged > 0 ? `(${logged} logged)` : '')
