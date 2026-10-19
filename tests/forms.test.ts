import type { Action } from '../src/runtime'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, spyOn } from 'bun:test'
import { t } from 'elysia'
import { chromium } from 'playwright-core'
import { compileKay } from '../src/compiler'
import { action, actionStub, formDescribed, formMarked } from '../src/runtime/action'
import { markInvalid } from '../src/runtime/invalid'
import { formsScript } from '../src/server/forms'
import { browserPath, testSite } from '../src/test'

// An element keeping its attributes, for the helpers an island runs on its fields.
function fakeElement(): Element {
  const attributes = new Map<string, string>()

  return {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  } as unknown as Element
}

// The islands built for the island form's tests, which load pages in Chromium only once they open one.
const site = await testSite({ routes: 'tests/fixtures/forms/src/routes', browser: true })
const { save, ping, busy, odd, enrol } = await import(join(import.meta.dir, 'fixtures/forms/src/routes/index.kay')) as {
  save: Action<Record<string, string | boolean>, unknown, 'website'>
  ping: Action<Record<string, never>, string>
  busy: Action<Record<string, string>, unknown>
  odd: Action<Record<string, never>, unknown>
  enrol: Action<Record<string, string>, unknown>
}
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)
const REFUSED = { name: 'A', password: 'hunter2', bio: 'Hi <b>', plan: 'pro', size: 'l', news: 'on', website: '' }

describe('a form posting to an action', () => {
  it('renders its own values, and marks nothing invalid, before any post', async () => {
    const { html } = await site.visit('/')

    expect(html).toContain('<input name="name" value="Ada">')
    expect(html).toContain('<textarea name="bio">Default bio</textarea>')
    expect(html).toContain('<option value="free" selected>Free</option><option value="pro">Pro</option>')
    expect(html).toContain('<input type="radio" name="size" value="s" checked>')
    expect(html).toContain('<input type="checkbox" name="terms" checked>')
    expect(html).not.toContain('aria-invalid')
    expect(html).toContain('<form class="busy" action="/_kay/action/tests/fixtures/forms/src/routes/index.kay/busy" method="post" enctype="multipart/form-data">')
  })

  it('shows a refused post again with what was sent, refused fields marked, a password never echoed', async () => {
    const { status, html } = await site.submit(save, REFUSED, { from: '/' })

    expect(status).toBe(422)
    expect(html).toContain('<input name="name" value="A" aria-invalid="true" aria-describedby="save-name-error">')
    expect(html).toContain('<input type="password" name="password">')
    expect(html).not.toContain('hunter2')
    expect(html).toContain('<textarea name="bio">Hi &lt;b></textarea>')
    expect(html).toContain('<option value="free">Free</option><option value="pro" selected>Pro</option>')
    expect(html).toContain('<input type="radio" name="size" value="s">')
    expect(html).toContain('<input type="radio" name="size" value="l" checked>')
    expect(html).toContain('<input type="checkbox" name="news" checked>')
    expect(html).toContain('<input type="checkbox" name="terms">')
    expect(html).toContain('<p id="save-name-error" class="error">Too short</p>')
    expect(html).toContain('<p class="status">422</p>')
  })

  it('describes a refused field by the message the template shows for it, keeping an id or a description of the template\'s own', async () => {
    const { status, html } = await site.submit(busy, { topic: 'ab', note: 'long' }, { from: '/' })

    expect(status).toBe(422)
    expect(html).toContain('<input name="topic" value="ab" aria-invalid="true" aria-describedby="topic-problem">')
    expect(html).toContain('<p id="topic-problem">Too short</p>')
    expect(html).toContain('<input name="note" value="long" aria-invalid="true" aria-describedby="note-help busy-note-error">')
    expect(html).toContain('<p id="busy-note-error" class="note-error">Too long</p>')
    expect(html).toContain('<form class="busy" action="/_kay/action/tests/fixtures/forms/src/routes/index.kay/busy?kay_back=%2F" method="post" enctype="multipart/form-data">')
  })

  it('describes a form by its own message once the handler refused it', async () => {
    const { status, html } = await site.submit(busy, { topic: 'abc' }, { from: '/' })

    expect(status).toBe(503)
    expect(html).toContain('<form class="busy" action="/_kay/action/tests/fixtures/forms/src/routes/index.kay/busy?kay_back=%2F" method="post" enctype="multipart/form-data" aria-describedby="busy-error">')
    expect(html).toContain('<p id="busy-error" class="busy-error">Try later</p>')
    expect(html).toContain('<input name="topic" value="abc">')
  })

  it('hands a component\'s describeField ids to a field the template describes when refused, before and after the post, and to no later field', async () => {
    const { pick } = await import(join(import.meta.dir, 'fixtures/forms/src/routes/described.kay')) as { pick: Action<Record<string, string>, unknown> }
    const before = await site.visit('/described')
    const refused = await site.submit(pick, { first: 'ab', second: 'x' }, { from: '/described' })

    expect(before.html).toContain('<label><input name="first" aria-describedby="pick-hint"><input name="second"></label>')
    expect(refused.status).toBe(422)
    expect(refused.html).toContain('<label><input name="first" value="ab" aria-invalid="true" aria-describedby="pick-first-error pick-hint"><input name="second" value="x"></label>')
  })

  it('leaves the honeypot empty when a bot filled it in', async () => {
    const { status, html } = await site.submit(save, { ...REFUSED, name: 'Ada', website: 'spam.example' }, { from: '/' })

    expect(status).toBe(422)
    expect(html).not.toContain('spam.example')
    expect(html).toContain('<input name="website" tabindex="-1" autocomplete="off" aria-hidden="true" aria-invalid="true">')
  })

  it('reads what the handler failed with, and what one that went through returned, off the action', async () => {
    const taken = await site.submit(save, { ...REFUSED, name: 'Ada' }, { from: '/' })
    const pinged = await site.submit(ping, {}, { from: '/' })

    expect(taken.status).toBe(409)
    expect(taken.html).toContain('<p class="taken">Taken</p>')
    expect(taken.html).toContain('<input name="name" value="Ada">')
    expect(pinged.html).toContain('<p class="done">Saved</p>')
    expect((await site.visit('/')).html).not.toContain('class="done"')
  })

  it('hands the islands how a refused post went without what it sent, a failure no island can read left out', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const refused = await site.submit(save, { ...REFUSED, name: 'Ada', website: 'spam.example' }, { from: '/' })
      const unsendable = await site.submit(odd, {}, { from: '/' })

      expect(refused.html).toContain('data-kay-outcome')
      expect(refused.html).not.toContain('spam.example')
      expect(refused.html).not.toContain('hunter2')
      expect(unsendable.status).toBe(409)
      expect(unsendable.html).not.toContain('data-kay-outcome')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot reach the page\'s islands'))
    }
    finally {
      warn.mockRestore()
    }
  })
})

describe('an action passed to a static component', () => {
  it('drives its form, whatever the action takes, through a prop typed Action<never, unknown> or NoInputAction<unknown>', async () => {
    const { html } = await site.visit('/passed')

    expect(html).toContain('<form action="/_kay/action/tests/fixtures/forms/src/routes/passed.kay/leave" method="post" enctype="multipart/form-data">')
    expect(html).toContain('<form action="/_kay/action/tests/fixtures/forms/src/routes/passed.kay/rename" method="post" enctype="multipart/form-data">')
  })
})

describe('the messages a refused form is described by', () => {
  const FORM = `form(action={add})
  input(name="title" aria-describedby="help")
  input(name="tag")
  input(name="slug" aria-describedby={hint})
  p {add.error('tag')}
  if add.error('title') as message
    p {message}
  if add.error('slug') as message
    p {message}
  for row of rows
    if add.error('tag') as message
      p.row {message}
  if add.error() as message
    p(id="own-form") {message}
  if other.error('x') as message
    p.other {message}
`

  it('names the element an if block shows first, or one holding the error, after a description of the field\'s own', () => {
    const { tsx } = compileKay(FORM, 'page.kay', { output: 'html' })

    expect(tsx).toContain('"<input name=\\"title\\"" + KayAttribute("value", KayFormValue((add), "title")) + KayAttribute("aria-invalid", KayFormInvalid((add), "title")) + KayFieldDescribed(KayFormInvalid((add), "title") ? "help add-title-error" : "help")')
    expect(tsx).toContain('KayFieldDescribed(KayFormInvalid((add), "tag") ? "add-tag-error" : undefined)')
    expect(tsx).toContain('<p id=\\"add-tag-error\\">')
    expect(tsx).toContain('<p id=\\"add-title-error\\">')
    expect(tsx).toContain('KayAttribute("aria-describedby", KayFormInvalid((add), "") ? "own-form" : undefined)')
  })

  it('leaves a bound description, a row of a for and another action\'s message alone', () => {
    const { tsx } = compileKay(FORM, 'page.kay', { output: 'html' })

    expect(tsx).not.toContain('KayFormInvalid((add), "slug") ?')
    expect(tsx).toContain('<p class=\\"row\\">')
    expect(tsx).toContain('<p class=\\"other\\">')
  })

  it('names an element inline in text holding the error', () => {
    const { tsx } = compileKay('form(action={add})\n  input(name="tag")\n  p Problem: #[span {add.error(\'tag\')}]\n', 'page.kay', { output: 'html' })

    expect(tsx).toContain('KayFieldDescribed(KayFormInvalid((add), "tag") ? "add-tag-error" : undefined)')
    expect(tsx).toContain('<span id=\\"add-tag-error\\">')
  })

  it('writes a pending block as the same status region in the island\'s template as on the server, its contents still bound', () => {
    const source = '---\nimport { add } from \'./page.kay\'\nconst { label } = props<{ label: string }>()\n---\nform(action={add})\n  button Add\n  pending\n    p {label}\n'
    const { tsx } = compileKay(source, 'page.kay', { output: 'dom' })

    expect(tsx).toContain('<div role=\\"status\\"><div data-kay-pending hidden><p></p></div><style>form[aria-busy=true] [data-kay-pending]{display:block!important}</style></div>')
  })

  it('describes the fields and the form of an island alike', () => {
    const { tsx } = compileKay(FORM, 'page.kay', { output: 'dom' })

    // The template keeps the field's own description, the effect adding and removing the message's id alone, so ids a component wrote stay.
    expect(tsx).toContain('<input name=\\"title\\" aria-describedby=\\"help\\">')
    expect(tsx).toMatch(/KayFormDescribed\(\w+, \(add\), "title", "add-title-error"\)/)
    expect(tsx).toMatch(/KayFormDescribed\(\w+, \(add\), "tag", "add-tag-error"\)/)
    expect(tsx).toMatch(/KayFormDescribed\(\w+, \(add\), "", "own-form"\)/)
    expect(tsx).toContain('<p id=\\"add-tag-error\\">')
    expect(tsx).not.toContain('KayFormInvalid((add), "slug") ?')
  })

  it('leaves a description of the field\'s own already naming the message as written, on the server and in an island', () => {
    const source = 'form(action={add})\n  input(name="title" aria-describedby="note title-problem")\n  if add.error(\'title\')\n    p#title-problem {add.error(\'title\')}\n'
    const html = compileKay(source, 'page.kay', { output: 'html' }).tsx
    const dom = compileKay(source, 'page.kay', { output: 'dom' }).tsx

    expect(html).not.toContain('title-problem title-problem')
    expect(html).not.toContain('KayFormInvalid((add), "title") ?')
    expect(dom).toContain('aria-describedby=\\"note title-problem\\"')
    expect(dom).not.toContain('KayFormDescribed(')
  })

  it('imports the island\'s description helper only for a form whose messages describe its fields', () => {
    expect(compileKay('form(action={add})\n  input(name="title")\n', 'page.kay', { output: 'dom' }).tsx).not.toContain('formDescribed')
    expect(compileKay('form(action={add})\n  input(name="title")\n  p {add.error(\'title\')}\n', 'page.kay', { output: 'dom' }).tsx).toContain('formDescribed as KayFormDescribed')
  })

  it('adds and removes the message\'s id alone, keeping the other ids in their order', () => {
    const attributes = new Map<string, string>()
    const element = {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
    } as unknown as Element
    let errors: Record<string, string> = {}
    const target = Object.assign(() => undefined, { [Symbol.for('kay.action')]: true, error: (field: string) => errors[field] })

    formDescribed(element, target, 'title', 'title-error')
    expect(attributes.has('aria-describedby')).toBe(false)

    errors = { title: 'Too short' }
    formDescribed(element, target, 'title', 'title-error')
    expect(attributes.get('aria-describedby')).toBe('title-error')

    attributes.set('aria-describedby', 'note  title-error hint')
    formDescribed(element, target, 'title', 'title-error')
    expect(attributes.get('aria-describedby')).toBe('note  title-error hint')

    errors = {}
    formDescribed(element, target, 'title', 'title-error')
    expect(attributes.get('aria-describedby')).toBe('note hint')

    attributes.set('aria-describedby', 'title-error title-error')
    formDescribed(element, target, 'title', 'title-error')
    expect(attributes.has('aria-describedby')).toBe(false)

    errors = { title: 'Too short' }
    attributes.set('aria-describedby', 'hint')
    formDescribed(element, target, 'title', 'title-error')
    expect(attributes.get('aria-describedby')).toBe('hint title-error')
  })

  it('marks an island\'s refused field through its own helper, the server keeping the attribute', () => {
    const source = 'form(action={add})\n  input(name="title")\n'
    const dom = compileKay(source, 'page.kay', { output: 'dom' }).tsx

    expect(dom).toMatch(/KayFormMarked\(\w+, \(add\), "title"\)/)
    expect(dom).toContain('formMarked as KayFormMarked')
    expect(dom).not.toContain('KayFormInvalid')
    expect(compileKay(source, 'page.kay', { output: 'html' }).tsx).toContain('KayAttribute("aria-invalid", KayFormInvalid((add), "title"))')
  })

  it('keeps a field invalid while any source marks it, takes the mark off once none does, and leaves one the page wrote', () => {
    const element = fakeElement()
    let errors: Record<string, string> = { title: 'Too short' }
    const target = Object.assign(() => undefined, { [Symbol.for('kay.action')]: true, error: (field: string) => errors[field] })
    const field = {}
    const invalid = () => element.getAttribute('aria-invalid')

    // The mark the server rendered for the refusal is kay's own.
    element.setAttribute('aria-invalid', 'true')
    formMarked(element, target, 'title')
    markInvalid(element, field, true)
    errors = {}
    formMarked(element, target, 'title')
    expect(invalid()).toBe('true')

    markInvalid(element, field, false)
    expect(invalid()).toBeNull()

    formMarked(element, target, 'title')
    markInvalid(element, field, false)
    expect(invalid()).toBeNull()

    errors = { title: 'Too short' }
    markInvalid(element, field, true)
    formMarked(element, target, 'title')
    markInvalid(element, field, false)
    expect(invalid()).toBe('true')

    errors = {}
    formMarked(element, target, 'title')
    expect(invalid()).toBeNull()

    // A mark the page wrote before any source stays, and a source that never marked the field leaves another's alone.
    const page = fakeElement()

    page.setAttribute('aria-invalid', 'true')
    markInvalid(page, field, true)
    markInvalid(page, field, false)
    expect(page.getAttribute('aria-invalid')).toBe('true')

    page.setAttribute('aria-invalid', 'false')
    markInvalid(page, {}, false)
    expect(page.getAttribute('aria-invalid')).toBe('false')
  })
})

describe('a form naming its fields with field and showing their messages with error lines', () => {
  const FORM = `form(action={add})
  error
  input(field="title" maxlength="10")
  error.text-sm title
  textarea(field="body")
  for row of rows
    error title
  if add.error('title') as message
    p.old {message}
`

  it('writes the name and the schema\'s constraints, the template\'s own kept', () => {
    const { tsx } = compileKay(FORM, 'page.kay', { output: 'html' })

    expect(tsx).toContain('"<input name=\\"title\\" maxlength=\\"10\\"" + KayFormConstraints((add), "title", ["field","maxlength"])')
    expect(tsx).toContain('"<textarea name=\\"body\\"" + KayFormConstraints((add), "body", ["field","type"])')
    expect(tsx).not.toContain('field=')
  })

  it('renders the messages in error lines the field and the form are described by, before an if block showing one', () => {
    const { tsx } = compileKay(FORM, 'page.kay', { output: 'html' })

    expect(tsx).toContain('KayErrorParagraph(KayFormError((add), ""), "add-error", "error")')
    expect(tsx).toContain('KayErrorParagraph(KayFormError((add), "title"), "add-title-error", "error text-sm")')
    expect(tsx).toContain('KayErrorParagraph(KayFormError((add), "title"), "", "error")')
    expect(tsx).toContain('KayFormInvalid((add), "title") ? "add-title-error" : undefined')
    expect(tsx).toContain('KayFormInvalid((add), "") ? "add-error" : undefined')
    expect(tsx).toContain('<p class=\\"old\\">')
  })

  it('renders an island\'s alike, without constraints, which kay\'s own check takes care of in the browser', () => {
    const { tsx } = compileKay(FORM, 'page.kay', { output: 'dom' })

    expect(tsx).toContain('KayErrorParagraph(KayFormError((add), "title"), "add-title-error", "error text-sm")')
    expect(tsx).toContain('<input name=\\"title\\" maxlength=\\"10\\">')
    expect(tsx).not.toContain('Constraints')
  })

  it('checks in the browser without JavaScript what the schema says, and shows the refused messages', async () => {
    const page = await site.visit('/')

    expect(page.html).toContain('<input name="title" required minlength="3" maxlength="40">')
    expect(page.html).toContain('<input name="email" required maxlength="200" type="email">')
    expect(page.html).toContain('<input name="age" type="number" min="1" max="120">')
    expect(page.html).toContain('<input name="agree" type="checkbox">')
    expect(page.html).not.toContain('enrol-title-error')

    const { status, html } = await site.submit(enrol, { title: 'ab', email: 'a@b.co', agree: 'on' }, { from: '/' })

    expect(status).toBe(422)
    expect(html).toContain('<input name="title" required minlength="3" maxlength="40" value="ab" aria-invalid="true" aria-describedby="enrol-title-error">')
    expect(html).toContain('<p id="enrol-title-error" class="error">Too short</p>')
    expect((await site.submit(enrol, { title: 'abc', email: 'a@b.co', agree: 'on' }, { from: '/' })).html).toContain('<p id="enrol-error" class="error">Full</p>')
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('an island form posting to an action', () => {
  it('hydrates the page a refused post renders as the server drew it, the field filled in and marked', async () => {
    const page = await site.open('/', { path })

    await page.fill('form.signup input', 'nope')
    await page.click('button.post')
    await page.waitFor('p.signup-error', { text: 'Not an email' })

    expect(await page.evaluate(() => document.querySelector('p.joined')?.outerHTML)).toBe('<p id="join-email-error" class="error joined">Not an email</p>')
    expect(await page.value('form.signup input')).toBe('nope')
    expect(await page.evaluate(() => document.querySelector('form.signup input')?.getAttribute('aria-invalid'))).toBe('true')
    expect(page.errors).toEqual([])
  })

  it('shows the page again once a call went through, unless the call says not to', async () => {
    const page = await site.open('/', { path })
    const before = Number(await page.text('p.tally'))

    await page.click('button.bump')
    await page.waitFor('p.tally', { text: String(before + 1) })
    await page.click('button.quiet')
    await page.evaluate(async () => new Promise(resolve => setTimeout(resolve, 300)))

    expect(await page.text('p.tally')).toBe(String(before + 1))

    await page.reload()

    expect(await page.text('p.tally')).toBe(String(before + 2))
    expect(page.errors).toEqual([])
  })

  // Whether the `pending` block of each form is shown, by the form's class.
  const shown = async (page: Awaited<ReturnType<typeof site.open>>) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('form')].map(form => [form.className, form.querySelector<HTMLElement>('[data-kay-pending]')?.checkVisibility() ?? null])))

  it('renders a pending block hidden, in a status region that is always there', async () => {
    const { html } = await site.visit('/pending')

    expect(html.match(/<div role="status"><div data-kay-pending hidden><p class="saving">Saving (?:slow|refused|leaves|island)<\/p><\/div><style>form\[aria-busy=true\] \[data-kay-pending\]\{display:block!important\}<\/style><\/div>/g)).toHaveLength(4)
  })

  it('shows a form\'s pending block while that form posts, and no other\'s, hiding it with the answer', async () => {
    const page = await site.open('/pending', { path })

    // The reset Tailwind's preflight writes for `hidden`, which a rule of the page's own must beat.
    await page.evaluate(() => {
      document.head.insertAdjacentHTML('beforeend', '<style>[hidden]:where(:not([hidden=until-found])){display:none!important}</style>')
    })

    expect(await shown(page)).toEqual({ slow: false, refused: false, leaves: false, island: false })

    await page.click('form.slow button')
    await page.waitFor('form.slow[aria-busy]')

    expect(await shown(page)).toEqual({ slow: true, refused: false, leaves: false, island: false })

    await page.waitFor('form.slow[aria-busy]', { gone: true })

    expect(await shown(page)).toEqual({ slow: false, refused: false, leaves: false, island: false })
    expect(page.errors).toEqual([])
  })

  it('hides it again once the post was refused', async () => {
    const page = await site.open('/pending', { path })

    await page.click('form.refused button')
    await page.waitFor('form.refused[aria-busy]')

    expect((await shown(page))?.refused).toBe(true)

    await page.waitFor('form.refused[aria-busy]', { gone: true })

    expect(await shown(page)).toEqual({ slow: false, refused: false, leaves: false, island: false })
    expect(page.errors).toEqual([])
  })

  it('shows it while a post that redirects is in flight, the page it leads to replacing it', async () => {
    const page = await site.open('/pending', { path })

    await page.click('form.leaves button')
    await page.waitFor('form.leaves[aria-busy]')

    expect((await shown(page))?.leaves).toBe(true)

    await page.waitFor('h1', { text: 'Other' })
    expect(page.errors).toEqual([])
  })

  it('shows the block of an island\'s form while its submit handler awaits a call', async () => {
    const page = await site.open('/pending', { path })

    await page.click('form.island button')
    await page.waitFor('form.island[aria-busy]')

    expect(await shown(page)).toEqual({ slow: false, refused: false, leaves: false, island: true })

    await page.waitFor('form.island[aria-busy]', { gone: true })

    expect((await shown(page))?.island).toBe(false)
    expect(page.errors).toEqual([])
  })

  it('lets a navigation the caller starts once a call went through win over the refresh', async () => {
    const page = await site.open('/', { path })

    await page.click('button.away')
    await page.waitFor('h1', { text: 'Other' })

    expect(await page.path()).toBe('/other')
    expect(page.errors).toEqual([])
  })

  it('keeps the page the visitor went to while a form was posting, the answer dropped', async () => {
    const page = await site.open('/', { path })

    await page.click('form.slow button')
    await page.waitFor('form.slow[aria-busy]')
    await page.click('a.other')
    await page.waitFor('h1', { text: 'Other' })
    await page.evaluate(async () => new Promise(resolve => setTimeout(resolve, 1000)))

    expect(await page.path()).toBe('/other')
    expect(page.errors).toEqual([])
  })

  it('leaves what a call was refused for on the page that made it', async () => {
    const page = await site.open('/', { path })

    await page.click('button.call')
    await page.waitFor('p.signup-error', { text: 'Not an email' })
    await page.click('a.other')
    await page.waitFor('h1', { text: 'Other' })
    await page.click('a.home')
    await page.waitFor('p.tally')

    expect(await page.text('p.signup-error')).toBeNull()
    expect(page.errors).toEqual([])
  })

  it('takes the forms posting to an action from the browser\'s own check, so the schema\'s messages show', async () => {
    const page = await site.open('/', { path })

    expect(await page.evaluate(() => [...document.forms].map(form => form.noValidate))).toEqual([true, true, true, true, true, true])

    await page.fill('form.enrol input[name="title"]', 'ab')
    await page.fill('form.enrol input[name="email"]', 'a@b.co')
    await page.click('form.enrol button')
    await page.waitUntil(() => (document.querySelector('form.enrol input[name="title"]') as HTMLInputElement).validationMessage === 'Too short')

    expect(await page.path()).toBe('/')
    expect(page.errors).toEqual([])
  })

  it('shows what a call was refused for, reactively', async () => {
    const page = await site.open('/', { path })

    expect(await page.text('p.signup-error')).toBeNull()

    await page.click('button.call')
    await page.waitFor('p.signup-error', { text: 'Not an email' })

    expect(await page.evaluate(() => document.querySelector('form.signup input')?.getAttribute('aria-invalid'))).toBe('true')
    expect(await page.evaluate(() => document.querySelector('form.signup input')?.getAttribute('aria-describedby'))).toBe('join-email-error')
    // The error line names the message, before the element an if block shows.
    expect(await page.evaluate(() => document.querySelector('p.joined')?.outerHTML)).toBe('<p id="join-email-error" class="error joined">Not an email</p>')
    expect(await page.evaluate(() => document.querySelector('p.signup-error')?.id)).toBe('')
    expect(page.errors).toEqual([])
  })

  it('keeps the ids a component handed a refused field once the island hydrates, and as the field turns valid and refused again', async () => {
    const page = await site.open('/described-island', { path })
    const described = async () => page.evaluate(() => [...document.querySelectorAll('form.described input')].map(input => [input.getAttribute('aria-describedby'), input.getAttribute('aria-invalid')]))

    await page.fill('form.described input[name="first"]', 'ab')
    await page.fill('form.described input[name="last"]', 'ab')
    await page.click('button.choose')
    await page.waitFor('#choose-first-error')
    // A click the island answers tells it hydrated.
    await page.click('button.bump')
    await page.waitFor('button.bump', { text: '1' })

    expect(await described()).toEqual([['choose-first-error choose-hint', 'true'], ['last-note choose-last-error last-hint', 'true']])

    await page.click('button.accept')
    await page.waitUntil(() => document.querySelector('form.described input[name="first"]')?.getAttribute('aria-invalid') === null)

    expect(await described()).toEqual([['choose-hint', null], ['last-note last-hint', null]])

    await page.click('button.refuse')
    await page.waitUntil(() => document.querySelector('form.described input[name="first"]')?.getAttribute('aria-invalid') === 'true')

    expect(await described()).toEqual([['choose-hint choose-first-error', 'true'], ['last-note last-hint choose-last-error', 'true']])
    expect(page.errors).toEqual([])
  })
})

describe('formsScript', () => {
  it('skips a stand-in action, which has no schema to read', () => {
    expect(formsScript(new Set([actionStub('/contact')]))).toBe('')
  })

  it('reads a function error again under kay dev, caching it otherwise', () => {
    let word = 'one'
    const saved = action(t.Object({ name: t.String({ minLength: 1, error: () => word }) }), () => undefined)
    const pages = new Set<Action<never, unknown>>([saved])

    expect(formsScript(pages)).toContain('one')
    word = 'two'
    expect(formsScript(pages)).toContain('one')
    expect(formsScript(pages, true)).toContain('two')
  })
})
