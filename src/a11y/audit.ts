import type { KayConfig } from '../config'
import type { TestPage } from '../test/browser'
import type { Skipped, Target } from './targets'
import process from 'node:process'
import { mountedAt } from '../dev/base-proxy'
import { startRenderServer } from '../dev/render-server'
import { joinBase } from '../runtime/base'
import { basePath } from '../server/base'
import { browse, browserPath } from '../test/browser'
import { pagesToAudit } from './targets'

// A rule of axe-core a page breaks, with the elements breaking it.
export interface Violation {
  rule: string
  impact: string | null
  help: string
  helpUrl: string
  tags: string[]
  // The page it was found on, by the path a visitor types, and its route's file.
  route: string
  file: string
  nodes: { target: string, html: string, source: string | undefined }[]
}

export interface Audited {
  path: string
  route: string
  file: string
  locale: string | undefined
}

export interface Audit {
  audited: Audited[]
  skipped: Skipped[]
  violations: Violation[]
}

// A page gets this long to answer, to load and to hydrate.
const PAGE_MS = '15s'
const ANSWER_MS = 15_000
const REDIRECTS = new Set([301, 302, 303, 307, 308])

export class A11yRefusedError extends Error {}

// Audits every page of the project in one Chrome, one tab reused, against its own server booted as `kay dev` serves it: the dev build marks each element with the `.kay` line it comes from.
export async function auditSite(root: string, config: KayConfig, progress: (path: string) => void = () => undefined): Promise<Audit> {
  const chrome = process.env.BUN_CHROME_PATH

  if (browserPath() === undefined)
    throw new A11yRefusedError(`kay a11y needs Chrome or Chromium, and none was found; install one, or give its path as BUN_CHROME_PATH${chrome === undefined || chrome === '' ? '' : ` (${chrome} is none)`}`)

  const { targets, skipped } = await pagesToAudit(root, config)
  const base = basePath(config.base)
  const result: Audit = { audited: [], skipped, violations: [] }

  if (targets.length === 0)
    return result

  const started = await startRenderServer(root, 'a11y', config, { port: true, inspect: true })

  if (typeof started === 'string')
    throw new A11yRefusedError(started)

  const origin = `http://127.0.0.1:${started.port}`
  const mounted = base === '' ? undefined : mountedAt(origin, base)
  const served = mounted?.origin ?? origin
  let page: TestPage | undefined

  try {
    for (const target of targets) {
      const url = `${served}${joinBase(base, target.path)}`

      progress(target.path)

      const why = await refusal(url)

      if (why !== undefined) {
        skipped.push({ path: target.path, route: target.route, file: target.file, why: why.why, failed: why.failed })

        continue
      }

      try {
        // Each page as a first visit: the locale cookie of the one before would send this one to another.
        if (page === undefined) {
          page = await browse(url, { timeout: PAGE_MS, strict: false, lenient: true })
          // The dev server's live reload keeps an event stream open per page, and Chrome opens six connections to a server: a few pages later none is left to load one.
          await page.initScript(() => {
            Reflect.set(window, 'EventSource', class {
              addEventListener = () => undefined

              close = () => undefined
            })
          })
        }
        else {
          await page.cdp('Network.clearBrowserCookies')
          await page.goto(url)
        }

        const landed = await page.path()

        if (landed !== new URL(url).pathname) {
          skipped.push({ path: target.path, route: target.route, file: target.file, why: `it lands on ${landed}`, failed: false })

          continue
        }

        const violations = await check(page, target)

        result.audited.push({ path: target.path, route: target.route, file: target.file, locale: target.locale })
        result.violations.push(...violations)
      }
      catch (error) {
        skipped.push({ path: target.path, route: target.route, file: target.file, why: `the browser could not check it: ${error instanceof Error ? error.message : String(error)}`, failed: true })
        page?.close()
        page = undefined
      }
    }
  }
  finally {
    page?.close()
    mounted?.stop()
    await started.stop()
  }

  return result
}

// What the server answers a page with before the browser opens it: only a 200 is audited, as a redirect lands on another page and a refusal is a sign-in the audit has none for.
async function refusal(url: string): Promise<{ why: string, failed: boolean } | undefined> {
  let response: Response

  try {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(ANSWER_MS) })
  }
  catch (error) {
    return { why: `the server did not answer: ${error instanceof Error ? error.message : String(error)}`, failed: true }
  }

  await response.body?.cancel()

  if (response.status === 200)
    return undefined

  if (REDIRECTS.has(response.status))
    return { why: `it redirects to ${response.headers.get('location') ?? 'another page'}`, failed: false }

  if (response.status === 401 || response.status === 403)
    return { why: `it answers ${response.status}: it needs a signed-in user`, failed: false }

  return { why: `it answers ${response.status}`, failed: response.status >= 500 }
}

async function check(page: TestPage, target: Target): Promise<Violation[]> {
  const found = await page.a11y()
  const sources = await page.evaluate((selectors: string[]) => selectors.map((selector) => {
    // An element inside a shadow root has no selector of the document's.
    if (selector.includes(' >>> '))
      return null

    try {
      return document.querySelector(selector)?.closest('[data-kay-src]')?.getAttribute('data-kay-src') ?? null
    }
    catch {
      return null
    }
  }), found.flatMap(violation => violation.nodes.map(node => node.target)))
  let index = 0

  return found.map(violation => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    helpUrl: violation.helpUrl,
    tags: violation.tags,
    route: target.path,
    file: target.file,
    nodes: violation.nodes.map(node => ({ ...node, source: sources[index++] ?? undefined })),
  }))
}
