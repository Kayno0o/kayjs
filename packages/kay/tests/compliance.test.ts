import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../src/build/index'
import { checkProject } from '../src/cli/check'
import { analyzeModule, checkCssCompliance, compileDom, compileSsr } from '../src/compiler/index'
import { testApp } from '../src/test/index'

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

function rulesOf(jsx: string, setup = ''): string[] {
  const code = `${setup}\nexport default function Page() { return ${jsx} }\n`
  return analyzeModule('Page.tsx', code).warnings.map(w => w.rule).filter((r): r is NonNullable<typeof r> => r !== undefined)
}

function messagesOf(jsx: string, setup = ''): string[] {
  const code = `${setup}\nexport default function Page() { return ${jsx} }\n`
  return analyzeModule('Page.tsx', code).warnings.map(w => w.message)
}

describe('RGAA static JSX compliance warnings (#3573)', () => {
  test('rgaa/img-alt flags <img> without alt and accepts alt="", dynamic alt, and spread', () => {
    expect(rulesOf('<img src="/hero.jpg" />')).toEqual(['rgaa/img-alt'])
    expect(messagesOf('<img src="/hero.jpg" />')[0]).toContain('[rgaa/img-alt]')
    expect(rulesOf('<img src="/hero.jpg" alt="Hero photo" />')).toEqual([])
    expect(rulesOf('<img src="/decorative.svg" alt="" />')).toEqual([])
    expect(rulesOf('<img src="/hero.jpg" alt={caption} />', 'const caption = "Hero"')).toEqual([])
    expect(rulesOf('<img src="/hero.jpg" {...props} />', 'const props = { alt: "x" }')).toEqual([])
  })

  test('rgaa/form-label flags unlabelled inputs, selects, and textareas', () => {
    expect(rulesOf('<input name="email" type="email" />')).toEqual(['rgaa/form-label'])
    expect(rulesOf('<select name="country"><option>FR</option></select>')).toEqual(['rgaa/form-label'])
    expect(rulesOf('<textarea name="bio" />')).toEqual(['rgaa/form-label'])

    // Exempt input types
    expect(rulesOf('<input type="hidden" name="csrf" value="1" />')).toEqual([])
    expect(rulesOf('<input type="submit" value="Send" />')).toEqual([])
    expect(rulesOf('<input type="reset" value="Reset" />')).toEqual([])
    expect(rulesOf('<input type="button" value="Click" />')).toEqual([])
    expect(rulesOf('<input type="image" src="/go.png" alt="Go" />')).toEqual([])

    // Accessible labelling patterns
    expect(rulesOf('<input name="q" aria-label="Search" />')).toEqual([])
    expect(rulesOf('<input name="q" aria-labelledby="search-heading" />')).toEqual([])
    expect(rulesOf('<input name="q" title="Search" />')).toEqual([])
    expect(rulesOf('<input {...fieldProps} />', 'const fieldProps = { name: "q" }')).toEqual([])
    expect(rulesOf('<label>Email <input name="email" type="email" /></label>')).toEqual([])
    expect(rulesOf('<><label for="email">Email</label><input id="email" name="email" /></>')).toEqual([])
    expect(rulesOf('<><label htmlFor={id}>Email</label><input id={id} name="email" /></>', 'const id = "f1"')).toEqual([])
    expect(rulesOf('<Field label="Email"><input name="email" /></Field>', 'const Field = (p: any) => <div>{p.children}</div>')).toEqual([])
  })

  test('rgaa/accessible-name flags empty or icon-only <button> and <a>', () => {
    expect(rulesOf('<button type="button"></button>')).toEqual(['rgaa/accessible-name'])
    expect(rulesOf('<a href="/home"></a>')).toEqual(['rgaa/accessible-name'])
    expect(rulesOf('<button type="button"><svg><path d="M0 0" /></svg></button>')).toEqual(['rgaa/accessible-name'])
    expect(rulesOf('<a href="/home"><img src="/logo.png" alt="" /></a>')).toEqual(['rgaa/accessible-name'])
    expect(rulesOf('<button type="button"><Icon /></button>', 'const Icon = () => <span />')).toEqual(['rgaa/accessible-name'])

    // Valid accessible names
    expect(rulesOf('<button type="button">Save</button>')).toEqual([])
    expect(rulesOf('<button type="button">{label}</button>', 'const label = "Save"')).toEqual([])
    expect(rulesOf('<button type="button" aria-label="Close"><svg /></button>')).toEqual([])
    expect(rulesOf('<a href="/home" title="Home"><svg /></a>')).toEqual([])
    expect(rulesOf('<a href="/home"><img src="/logo.png" alt="Acme home" /></a>')).toEqual([])
    expect(rulesOf('<button type="button"><svg><title>Close</title></svg></button>')).toEqual([])
    expect(rulesOf('<button type="button"><Icon label="Close" /></button>', 'const Icon = (p: any) => <span>{p.label}</span>')).toEqual([])
    expect(rulesOf('<button type="button" {...props}><svg /></button>', 'const props = { "aria-label": "Close" }')).toEqual([])
  })
})

describe('RGPD third-party URL warnings in TSX and CSS (#3573)', () => {
  test('flags external script, stylesheet/preload/preconnect/dns-prefetch link, and iframe unless inside <ConsentGate>', () => {
    expect(rulesOf('<script src="https://cdn.example.com/analytics.js" />')).toEqual(['rgpd/third-party-url'])
    expect(rulesOf('<script src="//cdn.example.com/analytics.js" />')).toEqual(['rgpd/third-party-url'])
    expect(rulesOf('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" />')).toEqual(['rgpd/third-party-url'])
    expect(rulesOf('<link rel="preconnect" href="https://fonts.gstatic.com" />')).toEqual(['rgpd/third-party-url'])
    expect(rulesOf('<link rel="preload" href="https://cdn.example.com/font.woff2" />')).toEqual(['rgpd/third-party-url'])
    expect(rulesOf('<link rel="dns-prefetch" href="https://stats.example.com" />')).toEqual(['rgpd/third-party-url'])
    expect(rulesOf('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Video" />')).toEqual(['rgpd/third-party-url'])

    // Same-origin / localhost / non-fetch link rels are fine
    expect(rulesOf('<script src="/_kay/app.js" />')).toEqual([])
    expect(rulesOf('<script src="http://localhost:3000/dev.js" />')).toEqual([])
    expect(rulesOf('<script src="http://127.0.0.1:4000/dev.js" />')).toEqual([])
    expect(rulesOf('<link rel="canonical" href="https://other.example.com/page" />')).toEqual([])

    // Wrapped inside <ConsentGate> (direct, aliased, and namespaced)
    expect(rulesOf(
      '<ConsentGate category="media"><iframe src="https://www.youtube.com/embed/abc" title="Video" /></ConsentGate>',
      'import { ConsentGate } from "@kayjs/kay"',
    )).toEqual([])
    expect(rulesOf(
      '<Gate category="analytics"><script src="https://cdn.example.com/a.js" /></Gate>',
      'import { ConsentGate as Gate } from "@kayjs/kay"',
    )).toEqual([])
    expect(rulesOf(
      '<kay.ConsentGate category="analytics"><script src="https://cdn.example.com/a.js" /></kay.ConsentGate>',
      'import * as kay from "@kayjs/kay"',
    )).toEqual([])
  })

  test('flags third-party @import and url(...) in CSS while skipping comments, relative URLs, localhost, and site origin', () => {
    const css = [
      '/* @import url("https://ignored-comment.example.com/a.css"); */',
      '@import url("https://fonts.googleapis.com/css2?family=Inter");',
      'body { background: url("https://cdn.example.com/bg.png"); }',
      '.local { background: url("/img/bg.png"); }',
      '.dev { background: url("http://localhost:3000/bg.png"); }',
      '.own { background: url("https://my-site.fr/hero.webp"); }',
    ].join('\n')

    const warnings = checkCssCompliance('src/styles/app.css', css, undefined, 'https://my-site.fr')
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('src/styles/app.css:2:')
    expect(warnings[0]).toContain('[rgpd/third-party-url]')
    expect(warnings[0]).toContain('fonts.googleapis.com')
    expect(warnings[1]).toContain('src/styles/app.css:3:')
    expect(warnings[1]).toContain('cdn.example.com')

    // Per-line and file-level CSS ignores
    const ignoredCss = [
      '/* kay-ignore rgpd/third-party-url */',
      '@import url("https://fonts.googleapis.com/css2?family=Inter");',
    ].join('\n')
    expect(checkCssCompliance('src/styles/app.css', ignoredCss)).toEqual([])
  })
})

describe('Silencing comments and project-level checks (LCEN, RGAA publicBody, site origin) (#3573)', () => {
  test('supports // kay-ignore <rule>, /* kay-ignore <rule> */, and kay-ignore-file (explicit rule required)', () => {
    const lineIgnored = [
      'export default function Page() {',
      '  return <div>',
      '    {/* kay-ignore rgaa/img-alt */}',
      '    <img src="/a.png" />',
      '    <img src="/b.png" />',
      '  </div>',
      '}',
    ].join('\n')
    const lineWarnings = analyzeModule('Page.tsx', lineIgnored).warnings
    expect(lineWarnings).toHaveLength(1)
    expect(lineWarnings[0]!.rule).toBe('rgaa/img-alt')

    const sameLineIgnored = [
      'export default function Page() {',
      '  return <img src="/a.png" /> // kay-ignore rgaa/img-alt',
      '}',
    ].join('\n')
    expect(analyzeModule('Page.tsx', sameLineIgnored).warnings).toEqual([])

    const fileIgnored = [
      '// kay-ignore-file rgaa/img-alt',
      'export default function Page() {',
      '  return <><img src="/a.png" /><img src="/b.png" /></>',
      '}',
    ].join('\n')
    expect(analyzeModule('Page.tsx', fileIgnored).warnings).toEqual([])

    // Missing or wrong rule code does NOT silence
    const missingRule = [
      '// kay-ignore',
      'export default function Page() { return <img src="/a.png" /> }',
    ].join('\n')
    expect(analyzeModule('Page.tsx', missingRule).warnings).toHaveLength(1)

    const wrongRule = [
      '// kay-ignore rgaa/form-label',
      'export default function Page() { return <img src="/a.png" /> }',
    ].join('\n')
    expect(analyzeModule('Page.tsx', wrongRule).warnings).toHaveLength(1)
  })

  test('kay check and production kay build warn on lcen/legal-notice, rgaa/accessibility-statement, and CSS URLs, respecting config', async () => {
    const dir = makeTemp('kay-compliance-proj-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/styles'), { recursive: true })

    writeFileSync(join(dir, 'kay.config.ts'), `
      export default {
        site: 'https://acme.fr',
        compliance: { publicBody: true },
      }
    `)
    writeFileSync(join(dir, 'src/styles/app.css'), `@import url("https://fonts.googleapis.com/css2?family=Inter");\n`)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import '../styles/app.css'
      export default function Home() {
        return (
          <main>
            <script src="https://acme.fr/own.js" />
            <img src="/banner.jpg" />
            <h1>Accueil</h1>
          </main>
        )
      }
    `)

    const res = await checkProject(dir, { skipTypecheck: true })
    expect(res.ok).toBe(true)
    expect(res.warnings.some(w => w.includes('[rgaa/img-alt]'))).toBe(true)
    expect(res.warnings.some(w => w.includes('[rgpd/third-party-url]') && w.includes('fonts.googleapis.com'))).toBe(true)
    // Same-origin `site` script is NOT flagged
    expect(res.warnings.some(w => w.includes('acme.fr/own.js'))).toBe(false)
    expect(res.warnings.some(w => w.includes('[lcen/legal-notice]'))).toBe(true)
    expect(res.warnings.some(w => w.includes('[rgaa/accessibility-statement]'))).toBe(true)

    // Production build emits compliance warnings; dev build skips project-level LCEN/RGAA route warnings
    const capturedProd: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { capturedProd.push(args.map(String).join(' ')) }
    try {
      await build({ root: dir })
    }
    finally {
      console.warn = origWarn
    }
    expect(capturedProd.some(w => w.includes('[lcen/legal-notice]'))).toBe(true)
    expect(capturedProd.some(w => w.includes('[rgaa/accessibility-statement]'))).toBe(true)
    expect(capturedProd.some(w => w.includes('[rgpd/third-party-url]'))).toBe(true)

    const capturedDev: string[] = []
    console.warn = (...args: unknown[]) => { capturedDev.push(args.map(String).join(' ')) }
    try {
      await build({ root: dir, dev: true })
    }
    finally {
      console.warn = origWarn
    }
    expect(capturedDev.some(w => w.includes('[lcen/legal-notice]'))).toBe(false)

    // Adding legal + accessibility routes and ignoring rgaa/img-alt & rgpd/third-party-url clears all warnings
    const cleanDir = makeTemp('kay-compliance-clean-')
    mkdirSync(join(cleanDir, 'src/routes'), { recursive: true })
    mkdirSync(join(cleanDir, 'src/styles'), { recursive: true })
    writeFileSync(join(cleanDir, 'src/styles/app.css'), `@import url("https://fonts.googleapis.com/css2?family=Inter");\n`)
    writeFileSync(join(cleanDir, 'src/routes/index.tsx'), `
      import '../styles/app.css'
      export default function Home() {
        return <main><img src="/banner.jpg" /><h1>Accueil</h1></main>
      }
    `)
    writeFileSync(join(cleanDir, 'src/routes/mentions-legales.tsx'), 'export default function Mentions() { return <h1>Mentions</h1> }\n')
    writeFileSync(join(cleanDir, 'src/routes/accessibilite.tsx'), 'export default function A11y() { return <h1>Accessibilité</h1> }\n')
    writeFileSync(join(cleanDir, 'kay.config.ts'), `
      export default {
        site: 'https://acme.fr',
        compliance: { publicBody: true, ignore: ['rgaa/img-alt', 'rgpd/third-party-url'] },
      }
    `)
    const clean = await checkProject(cleanDir, { skipTypecheck: true })
    expect(clean.ok).toBe(true)
    expect(clean.warnings).toEqual([])
  })

  test('API-only apps and compliance.legalNotice: false / custom path do not warn on lcen/legal-notice', async () => {
    const apiDir = makeTemp('kay-compliance-api-')
    mkdirSync(join(apiDir, 'src/routes/api'), { recursive: true })
    writeFileSync(join(apiDir, 'src/routes/api/health.ts'), 'export function GET() { return Response.json({ ok: true }) }\n')
    const apiCheck = await checkProject(apiDir, { skipTypecheck: true })
    expect(apiCheck.warnings).toEqual([])

    const customDir = makeTemp('kay-compliance-custom-legal-')
    mkdirSync(join(customDir, 'src/routes/info'), { recursive: true })
    writeFileSync(join(customDir, 'kay.config.ts'), `export default { compliance: { legalNotice: '/info/legal-notice' } }\n`)
    writeFileSync(join(customDir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Hi</h1> }\n')
    writeFileSync(join(customDir, 'src/routes/info/legal-notice.tsx'), 'export default function Legal() { return <h1>Legal</h1> }\n')
    expect((await checkProject(customDir, { skipTypecheck: true })).warnings).toEqual([])

    const disabledDir = makeTemp('kay-compliance-no-legal-')
    mkdirSync(join(disabledDir, 'src/routes'), { recursive: true })
    writeFileSync(join(disabledDir, 'kay.config.ts'), `export default { compliance: { legalNotice: false } }\n`)
    writeFileSync(join(disabledDir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Hi</h1> }\n')
    expect((await checkProject(disabledDir, { skipTypecheck: true })).warnings).toEqual([])
  })
})

describe('One-declaration CNIL/RGPD consent gating (#3573)', () => {
  test('<ConsentGate> is refused inside interactive islands at compile time', () => {
    const code = `
      import { ConsentGate, signal } from '@kayjs/kay'
      export default function Island() {
        const n = signal(0)
        return <button type="button" onClick={() => n.value++}><ConsentGate category="analytics"><span>{n.value}</span></ConsentGate></button>
      }
    `
    expect(() => compileSsr('Island.tsx', code)).toThrow(/<ConsentGate> in an island/)
    expect(() => compileDom('Island.tsx', code)).toThrow(/<ConsentGate> in an island/)
  })

  test('gates non-essential cookies and <ConsentGate> with 0 KB browser JS, CSRF-protected POST /_kay/consent (HTML form + JSON)', async () => {
    const dir = makeTemp('kay-consent-e2e-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'kay.config.ts'), `
      export default {
        consent: {
          categories: { analytics: 'Audience measurement', media: 'External video embeds' },
        },
        compliance: { legalNotice: false },
      }
    `)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import type { PageProps, RouteContext } from '@kayjs/kay'
      import { ConsentGate } from '@kayjs/kay'

      export function load(ctx: RouteContext) {
        ctx.cookies.set('session_id', 'essential-ok')
        ctx.cookies.set('ga_id', 'GA-123', { category: 'analytics' })
        ctx.cookies.set('yt_pref', 'hd', { category: 'media' })
        return {
          decided: ctx.consent.decided,
          categories: [...ctx.consent.categories],
          all: ctx.consent.all(),
        }
      }

      export default function Home({ data }: PageProps<typeof load>) {
        return (
          <main>
            <p id="state">{JSON.stringify(data)}</p>
            <ConsentGate category="analytics" fallback={<p id="analytics-fallback">Analytics disabled</p>}>
              <script src="https://stats.example.com/tracker.js" />
            </ConsentGate>
            <ConsentGate category="media" fallback={<p id="media-fallback">Media blocked</p>}>
              <iframe src="https://video.example.com/embed/1" title="Demo video" />
            </ConsentGate>
          </main>
        )
      }
    `)

    // Verify zero compliance warnings (third-party tags are inside <ConsentGate>)
    expect((await checkProject(dir, { skipTypecheck: true })).warnings).toEqual([])

    const app = await testApp({ root: dir })
    // 0 KB browser JS shipped for <ConsentGate>!
    expect(app.manifest!.runtimeScript).toBeUndefined()

    // 1. Before consent: essential cookie works, analytics & media cookies refused, fallbacks rendered
    const initial = await app.get('/')
    expect(initial.status).toBe(200)
    const initialHtml = await initial.text()
    expect(initialHtml).toContain('Analytics disabled')
    expect(initialHtml).toContain('Media blocked')
    expect(initialHtml).not.toContain('stats.example.com')
    expect(initialHtml).not.toContain('video.example.com')
    expect(app.cookies.get('session_id')).toBe('essential-ok')
    expect(app.cookies.get('ga_id')).toBeUndefined()
    expect(app.cookies.get('yt_pref')).toBeUndefined()

    // 2. GET /_kay/consent returns 405 Allow: POST
    const wrongMethod = await app.get('/_kay/consent')
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toContain('POST')

    // 3. Cross-site POST /_kay/consent is rejected with 403 CSRF
    const csrfRes = await app.fetch(new Request('http://localhost/_kay/consent', {
      method: 'POST',
      headers: { 'origin': 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ acceptAll: true }),
    }))
    expect(csrfRes.status).toBe(403)

    // 4. Zero-JS HTML form POST granting only analytics (granular checkbox) -> 303 redirect to Referer
    const formBody = new URLSearchParams({ analytics: 'on' })
    const formRes = await app.fetch(new Request('http://localhost/_kay/consent', {
      method: 'POST',
      headers: {
        'origin': 'http://localhost',
        'referer': 'http://localhost/?from=banner',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: formBody,
    }))
    expect(formRes.status).toBe(303)
    expect(formRes.headers.get('location')).toBe('/?from=banner')
    const setCookie = formRes.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('kay_consent=v1%3Aanalytics')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Max-Age=15552000')

    // 5. After granting analytics only: ga_id cookie + analytics script active; media still blocked
    const afterAnalytics = await app.get('/')
    const analyticsHtml = await afterAnalytics.text()
    expect(analyticsHtml).toContain('https://stats.example.com/tracker.js')
    expect(analyticsHtml).not.toContain('Analytics disabled')
    expect(analyticsHtml).toContain('Media blocked')
    expect(analyticsHtml).not.toContain('video.example.com')
    expect(app.cookies.get('ga_id')).toBe('GA-123')
    expect(app.cookies.get('yt_pref')).toBeUndefined()

    // 6. JSON POST acceptAll -> 200 JSON + both categories active
    const acceptJson = await app.post('/_kay/consent', { acceptAll: true })
    expect(acceptJson.status).toBe(200)
    expect(await acceptJson.json()).toEqual({
      ok: true,
      decided: true,
      consent: { analytics: true, media: true },
    })

    const afterAll = await app.get('/')
    const allHtml = await afterAll.text()
    expect(allHtml).toContain('https://stats.example.com/tracker.js')
    expect(allHtml).toContain('https://video.example.com/embed/1')
    expect(app.cookies.get('yt_pref')).toBe('hd')

    // 7. HTML form POST reject-all -> revokes consent and blocks non-essential cookies & gates again
    app.clearCookies()
    const rejectBody = new URLSearchParams({ action: 'reject-all' })
    const rejectRes = await app.fetch(new Request('http://localhost/_kay/consent', {
      method: 'POST',
      headers: { 'origin': 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
      body: rejectBody,
    }))
    expect(rejectRes.status).toBe(303)
    expect(app.cookies.get('kay_consent')).toBe('v1:')

    const afterReject = await app.get('/')
    const rejectedHtml = await afterReject.text()
    expect(rejectedHtml).toContain('Analytics disabled')
    expect(rejectedHtml).toContain('Media blocked')
    expect(rejectedHtml).toContain('&quot;decided&quot;:true')
    expect(app.cookies.get('ga_id')).toBeUndefined()
    expect(app.cookies.get('yt_pref')).toBeUndefined()
  })
})

test('the consent redirect stays on the site, from the form field and from the Referer (#3654)', async () => {
  const dir = makeTemp('kay-consent-redirect-')
  mkdirSync(join(dir, 'src/routes'), { recursive: true })
  writeFileSync(join(dir, 'kay.config.ts'), `export default { consent: { categories: { analytics: 'Audience' } }, compliance: { legalNotice: false } }`)
  writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <p>home</p> }')
  const app = await testApp({ root: dir })
  const locationAfter = async (fields: Record<string, string>, referer: string): Promise<string | null> => {
    const res = await app.fetch(new Request('http://localhost/_kay/consent', {
      method: 'POST',
      headers: { 'origin': 'http://localhost', referer, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'reject-all', ...fields }),
    }))
    return res.headers.get('location')
  }

  expect(await locationAfter({ redirect: '/a' }, 'http://localhost/')).toBe('/a')
  expect(await locationAfter({ redirect: '/\\evil.example/x' }, 'http://localhost/')).toBe('/')
  expect(await locationAfter({ redirect: '//evil.example/x' }, 'http://localhost/')).toBe('/')
  expect(await locationAfter({ redirect: '/a\r\nset-cookie: x=1' }, 'http://localhost/')).toBe('/')
  expect(await locationAfter({ redirect: '/\t/evil.example/x' }, 'http://localhost/')).toBe('/')
  expect(await locationAfter({ redirect: '/a\\b' }, 'http://localhost/')).toBe('/')
  expect(await locationAfter({ redirect: ' /a ' }, 'http://localhost/')).toBe('/a')
  expect(await locationAfter({}, 'http://localhost/b?c=1')).toBe('/b?c=1')
  expect(await locationAfter({}, 'http://localhost//evil.example/x')).toBe('/')
  expect(await locationAfter({}, 'http://localhost/\\evil.example/x')).toBe('/')
})
