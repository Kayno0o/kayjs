import type { AssertionResult, VerifyContext } from '../../lib/types'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, AssertionCollector, extractFormActions, readAppSourceFiles } from '../../lib/assertions'

export async function verify({ dir, app }: VerifyContext): Promise<AssertionResult[]> {
  const c = new AssertionCollector()

  let actionUrl = ''
  await c.run('GET / renders a progressive POST form targeting a kay action', async () => {
    const res = await app.get('/')
    assert(res.status === 200, `expected 200, got ${res.status}`)
    const html = await res.text()
    assert(/<form\b[^>]*\bmethod=["']post["']/i.test(html), 'missing <form method="post">')
    const actions = extractFormActions(html)
    const kayAction = actions.find(a => a.startsWith('/_kay/action/'))
    assert(kayAction !== undefined, `no /_kay/action/* form action found (saw: ${actions.join(', ') || 'none'})`)
    actionUrl = kayAction
    return `action URL: ${actionUrl}`
  })

  await c.run('invalid JSON POST returns 4xx with fieldErrors', async () => {
    assert(actionUrl !== '', 'skipped: no action URL')
    const res = await app.post(actionUrl, { name: 'A', email: 'not-an-email', message: 'short' })
    assert(res.status >= 400 && res.status < 500, `expected 4xx validation error, got ${res.status}`)
    const body = await res.json() as { ok?: boolean, fieldErrors?: Record<string, string>, error?: string }
    assert(body.ok === false, `expected ok: false, got ${JSON.stringify(body)}`)
    const hasErrors = (body.fieldErrors !== undefined && Object.keys(body.fieldErrors).length > 0) || Boolean(body.error)
    assert(hasErrors, `expected fieldErrors or error message, got ${JSON.stringify(body)}`)
  })

  await c.run('zero-JS invalid form POST redirects (303) with flash cookie rendered on GET /', async () => {
    assert(actionUrl !== '', 'skipped: no action URL')
    app.clearCookies()
    const res = await app.submit(
      actionUrl,
      { name: 'A', email: 'bad', message: 'too short' },
      { referer: 'http://localhost/', accept: 'text/html' },
    )
    assert(res.status === 303, `expected 303 redirect on invalid zero-JS form POST, got ${res.status}`)
    const loc = res.headers.get('location') ?? ''
    assert(loc === '/' || loc.endsWith('/'), `expected redirect back to /, got "${loc}"`)
    assert(app.cookies.has('__kay_action_err'), 'expected __kay_action_err flash cookie to be set')

    const follow = await app.get('/')
    assert(follow.status === 200, `expected 200 on follow-up GET /, got ${follow.status}`)
    const html = await follow.text()
    assert(/role=["']alert["']|error|invalid|required|character|email/i.test(html), 'follow-up GET / did not render flash validation error')
  })

  await c.run('valid JSON POST succeeds with ok: true and data', async () => {
    assert(actionUrl !== '', 'skipped: no action URL')
    const res = await app.post(actionUrl, {
      name: 'Alice Martin',
      email: 'alice@example.com',
      message: 'This is a valid feedback message with enough detail.',
    })
    assert(res.status === 200, `expected 200, got ${res.status}`)
    const body = await res.json() as { ok?: boolean, data?: unknown }
    assert(body.ok === true && body.data !== undefined, `expected { ok: true, data }, got ${JSON.stringify(body)}`)
  })

  await c.run('source uses useAction(), getActionError(), and has testApp tests', async () => {
    const sources = [...readAppSourceFiles(dir).values()].join('\n')
    assert(/\buseAction\s*\(/.test(sources), 'missing useAction() in src/')
    assert(/\bgetActionError\s*\(/.test(sources), 'missing getActionError() in src/')

    const testsDir = join(dir, 'tests')
    assert(existsSync(testsDir), 'missing tests/ directory')
    const testFiles = readdirSync(testsDir).filter(f => /\.(?:test|spec)\.tsx?$/.test(f))
    assert(testFiles.length >= 1, 'no test file found under tests/')
    const testSrc = testFiles.map(f => readFileSync(join(testsDir, f), 'utf8')).join('\n')
    assert(/\btestApp\s*\(/.test(testSrc), 'tests do not use testApp() from @kayjs/kay/test')
  })

  return c.results
}
