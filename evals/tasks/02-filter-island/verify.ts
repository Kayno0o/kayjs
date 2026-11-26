import type { AssertionResult, VerifyContext } from '../../lib/types'
import { assert, AssertionCollector, readAppSourceFiles } from '../../lib/assertions'

export async function verify({ dir, app, bundleReport }: VerifyContext): Promise<AssertionResult[]> {
  const c = new AssertionCollector()

  let html = ''
  await c.run('GET / returns 200 with SSR products and accessible filter controls', async () => {
    const res = await app.get('/')
    assert(res.status === 200, `expected 200, got ${res.status}`)
    html = await res.text()
    assert(/<input\b/i.test(html), 'missing search/filter <input> element')
    assert(/<select\b/i.test(html), 'missing category/sort <select> element')
    assert(/<label\b[^>]*\bfor=["'][^"']+["']/i.test(html), 'missing accessible <label for="..."> wiring')
    const itemMatches = html.match(/<(?:li|article|tr)\b/gi) ?? []
    assert(itemMatches.length >= 6, `expected at least 6 SSR product items, found ${itemMatches.length}`)
  })

  await c.run('route mounts an automatic island within 15 KB eager JS budget', async () => {
    assert(/<kay-island\b/i.test(html), 'rendered HTML does not contain a <kay-island> mount')
    assert(bundleReport !== undefined, 'missing BundleReport from kay build --analyze --json')
    const homeRoute = bundleReport.routes.find(r => r.path === '/') ?? bundleReport.routes[0]
    assert(homeRoute !== undefined, 'no routes in bundle report')
    assert(homeRoute.jsGzip > 0, 'expected non-zero client JS for interactive island')
    assert(homeRoute.jsGzip <= 15 * 1024, `eager JS ${homeRoute.jsGzip} B exceeds 15 KB budget`)
    return `eager JS: ${homeRoute.jsGzip} B (${homeRoute.islands.length} island(s))`
  })

  await c.run('source uses signal, computed, useId, reactive .map(), and server load()', async () => {
    const sources = [...readAppSourceFiles(dir).values()].join('\n')
    assert(/\bsignal\s*\(/.test(sources), 'missing signal() call')
    assert(/\bcomputed\s*\(/.test(sources), 'missing computed() call')
    assert(/\buseId\s*\(/.test(sources), 'missing useId() call')
    assert(/\.map\s*\(/.test(sources), 'missing .map() list rendering')
    assert(/export\s+(?:async\s+)?function\s+load\b/.test(sources), 'missing server load() export in route')
  })

  return c.results
}
