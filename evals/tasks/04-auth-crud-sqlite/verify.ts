import type { AssertionResult, VerifyContext } from '../../lib/types'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, AssertionCollector, extractFormActions, readAppSourceFiles } from '../../lib/assertions'

export async function verify({ dir, app }: VerifyContext): Promise<AssertionResult[]> {
  const c = new AssertionCollector()

  await c.run('unauthenticated /notes redirects HTML to /login and returns 401 for JSON', async () => {
    app.clearCookies()
    const htmlRes = await app.get('/notes', { accept: 'text/html' })
    assert(htmlRes.status === 302 || htmlRes.status === 303, `expected 302/303 redirect, got ${htmlRes.status}`)
    const loc = htmlRes.headers.get('location') ?? ''
    assert(loc.includes('/login'), `expected redirect location to contain /login, got "${loc}"`)

    const jsonRes = await app.get('/notes', { accept: 'application/json' })
    assert(jsonRes.status === 401, `expected 401 for unauthenticated JSON request, got ${jsonRes.status}`)
  })

  await c.run('GET /login renders login page', async () => {
    const res = await app.get('/login')
    assert(res.status === 200, `expected 200, got ${res.status}`)
    const html = await res.text()
    assert(/<form\b/i.test(html), 'missing <form> on /login')
  })

  let notesHtml = ''
  const email = `eval-${Date.now()}@example.com`
  const password = 'correct-horse-battery-staple-99'

  await c.run('POST /auth/signup opens an authenticated session and unlocks /notes', async () => {
    app.clearCookies()
    const signup = await app.post('/auth/signup', { email, password, name: 'Eval User' })
    assert(signup.status >= 200 && signup.status < 400, `signup failed with ${signup.status}: ${await signup.text()}`)

    const notesRes = await app.get('/notes', { accept: 'text/html' })
    assert(notesRes.status === 200, `expected 200 on authenticated GET /notes, got ${notesRes.status}`)
    notesHtml = await notesRes.text()
  })

  await c.run('creating a note persists to SQLite and renders on GET /notes', async () => {
    const actions = extractFormActions(notesHtml).filter(u => u.startsWith('/_kay/action/'))
    assert(actions.length >= 1, `no /_kay/action/* form found on /notes (found: ${extractFormActions(notesHtml).join(', ') || 'none'})`)

    const markerTitle = `Eval Note ${Date.now()}`
    const markerBody = 'Persisted via bun:sqlite in kay v2 eval'
    let created = false

    for (const actionUrl of actions) {
      const res = await app.submit(
        actionUrl,
        { title: markerTitle, body: markerBody },
        { referer: 'http://localhost/notes', accept: 'text/html' },
      )
      if (res.status >= 200 && res.status < 400) {
        const after = await app.get('/notes', { accept: 'text/html' })
        const afterHtml = await after.text()
        if (afterHtml.includes(markerTitle)) {
          created = true
          break
        }
      }
    }
    assert(created, 'submitting a note to /notes action did not persist & render the new note')
  })

  await c.run('POST /auth/signout clears session and re-protects /notes', async () => {
    const signout = await app.post('/auth/signout', {})
    assert(signout.status >= 200 && signout.status < 400, `signout failed with ${signout.status}`)

    const after = await app.get('/notes', { accept: 'text/html' })
    assert(after.status === 302 || after.status === 303, `expected redirect after signout, got ${after.status}`)
  })

  await c.run('uses sqliteAuthStore, auth.guard(), @kayjs/ui, bun:sqlite, and testApp tests', async () => {
    const sources = [...readAppSourceFiles(dir).values()].join('\n')
    assert(/\bsqliteAuthStore\b/.test(sources), 'missing sqliteAuthStore from @kayjs/auth/sqlite')
    assert(/auth\.guard\s*\(/.test(sources), 'missing auth.guard() middleware')
    assert(/@kayjs\/ui/.test(sources), 'missing @kayjs/ui import')
    assert(/bun:sqlite/.test(sources), 'missing bun:sqlite usage')

    const testsDir = join(dir, 'tests')
    assert(existsSync(testsDir), 'missing tests/ directory')
    const testFiles = readdirSync(testsDir).filter(f => /\.(?:test|spec)\.tsx?$/.test(f))
    assert(testFiles.length >= 1, 'no test files found in tests/')
    const testSrc = testFiles.map(f => readFileSync(join(testsDir, f), 'utf8')).join('\n')
    assert(/\btestApp\s*\(/.test(testSrc), 'tests do not use testApp()')
  })

  return c.results
}
