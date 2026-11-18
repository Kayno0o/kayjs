import type { Action } from '../src/runtime'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { formInitial, formInitialChecked } from '../src/runtime/internal'
import { browserPath, testSite } from '../src/test'

const site = await testSite({ root: 'tests/fixtures/form-once', browser: true })
const { save } = await import(join(import.meta.dir, 'fixtures/form-once/src/routes/index.kay')) as { save: Action<Record<string, string | boolean | string[]>, unknown> }
const { rename } = await import(join(import.meta.dir, 'fixtures/form-once/src/routes/island.kay')) as { rename: Action<Record<string, string | boolean>, unknown> }
const { edit } = await import(join(import.meta.dir, 'fixtures/form-once/src/routes/many.kay')) as { edit: Action<Record<string, string>, unknown> }
const path = browserPath()
const mounted = await testSite({ root: 'tests/fixtures/form-once', islands: false, config: { base: '/blog', trailingSlash: 'always' } })

describe('a form given the record its fields start from', () => {
  it('fills the fields and shows a refused post under a base path', async () => {
    const { html } = await mounted.visit('/blog/')

    expect(html).toContain('value="Buy milk"')
    expect(html).toContain('<option value="m" selected>Medium</option>')

    const refused = await mounted.submit(save, { title: 'ab', size: 's', kind: '1' }, { from: '/blog/' })

    expect(refused.status).toBe(422)
    expect(refused.html).toContain('value="ab" aria-invalid="true"')
    expect(refused.html).not.toContain('Buy milk')
    expect(refused.html).toContain('<option value="s" selected>Small</option>')
  })

  it('fills every kind of field on a static page, the template\'s own value and a null left as written', async () => {
    const { html } = await site.visit('/')

    expect(html).toContain('<input name="title" required minlength="3" maxlength="40" value="Buy milk">')
    expect(html).toContain('<input name="done" type="checkbox" checked>')
    expect(html).toContain('<textarea name="note" maxlength="200">two\nlines &lt;b></textarea>')
    expect(html).toContain('<option value="s">Small</option><option value="m" selected>Medium</option>')
    expect(html).toContain('<input name="kind" type="radio" value="1" maxlength="10">')
    expect(html).toContain('<input name="kind" type="radio" value="2" maxlength="10" checked>')
    expect(html).toContain('<input name="tags" type="checkbox" value="a" checked>')
    expect(html).toContain('<input name="tags" type="checkbox" value="b">')
    expect(html).toContain('<input name="tags" type="checkbox" value="c" checked>')
    expect(html).toContain('<input name="count" type="number" value="3">')
    expect(html).toContain('<input name="due" type="date" maxlength="10" value="2026-03-04">')
    expect(html).toContain('<input name="at" type="datetime-local" maxlength="10000" value="2026-03-04T23:30">')
    expect(html).toContain('<input name="from" type="time" maxlength="10000" value="23:30">')
    expect(html).toContain('<input name="nick" maxlength="20" value="anon">')
    expect(html).not.toContain('values=')
  })

  it('shows a refusal that read no field blank, no box ticked from the record', async () => {
    const { status, html } = await site.submit(save, {}, { from: '/' })

    expect(status).toBe(422)
    expect(html).toContain('<input name="done" type="checkbox">')
    expect(html).toContain('<input name="tags" type="checkbox" value="a">')
    expect(html).not.toContain(' checked')
  })

  it('shows a refused post\'s values over the record, a box it left unticked unticked', async () => {
    const { status, html } = await site.submit(save, { title: 'ab', note: '', size: 's', kind: '1', tags: ['b'] }, { from: '/' })

    expect(status).toBe(422)
    expect(html).toContain('value="ab" aria-invalid="true"')
    expect(html).not.toContain('Buy milk')
    expect(html).toContain('<textarea name="note" maxlength="200"></textarea>')
    expect(html).toContain('<input name="done" type="checkbox">')
    expect(html).toContain('<option value="s" selected>Small</option><option value="m">Medium</option>')
    expect(html).toContain('<input name="kind" type="radio" value="1" maxlength="10" checked>')
    expect(html).toContain('<input name="tags" type="checkbox" value="b" checked>')
    expect(html).toContain('<input name="tags" type="checkbox" value="c">')
  })

  it('writes the same code on the server and in the browser, the record read once per field', () => {
    const source = 'form(action={save} values={todo})\n  input(field="title")\n  input(field="done" type="checkbox")\n'
    const server = compileKay(source, 'page.kay', { output: 'html' }).tsx
    const browser = compileKay(source, 'page.kay', { output: 'dom' }).tsx

    // The server types an input the template gives no `type` by its schema, which the browser has not.
    expect(server).toContain('KayFormInitial((todo), "title", KaySchemaType)')
    expect(server).toContain('KayFormInitialChecked((todo), "done", undefined)')
    expect(browser).toContain('KayFormInitial((todo), "title")')
    expect(browser).toContain('KayFormInitialChecked((todo), "done", undefined)')
  })

  it('fills a field in the browser that carries a handler or a ref', () => {
    const browser = compileKay('script\n  const log = () => {}\nform(action={save} values={todo})\n  input(field="title" onInput={log})\n  input(field="done" type="checkbox" onChange={log})\n', 'page.kay', { output: 'dom' }).tsx

    expect(browser).toContain('KayFormInitial((todo), "title")')
    expect(browser).toContain('KayFormInitialChecked((todo), "done", undefined)')
  })

  it('leaves a field with a value of its own, and a form with no record, as written', () => {
    const own = compileKay('form(action={save} values={todo})\n  input(field="title" value="x")\n', 'page.kay', { output: 'dom' }).tsx
    const none = compileKay('form(action={save})\n  input(field="title")\n', 'page.kay', { output: 'html' }).tsx

    expect(own).not.toContain('KayFormInitial((todo), "title")')
    expect(none).not.toContain('Initial')
  })

  it('refuses a record that calls a function, which every field would run', () => {
    const codes = (values: string) => compileKay(`form(action={save} values=${values})\n  input(field="title")\n`, 'a.kay', { check: true }).diagnostics.map(diagnostic => diagnostic.code)

    expect(codes('{load(id)}')).toContain('form-misuse')
    expect(codes('{todo()}')).not.toContain('form-misuse')
    expect(codes('{props.todo}')).not.toContain('form-misuse')
    expect(codes('{{ title: x }}')).not.toContain('form-misuse')
  })

  it('writes the type a date field starts from, and fills a textarea with its own text from the record', () => {
    const source = 'form(action={save} values={todo})\n  input(field="due" type="DATE")\n  input(field="note" type="text")\n  textarea(field="body") own text\n'

    for (const output of ['html', 'dom'] as const) {
      const { tsx } = compileKay(source, 'page.kay', { output })

      expect(tsx).toContain('KayFormInitial((todo), "due", "date")')
      expect(tsx).toContain('KayFormInitial((todo), "note")')
      expect(tsx).toContain('KayFormInitial((todo), "body")')
    }
  })

  it('type-checks the record against the action\'s fields', () => {
    const { tsx } = compileKay('form(action={save} values={todo})\n  input(field="title")\n', 'page.kay', { check: true })

    expect(tsx).toContain('{...KayFormValues((save), (todo))}')
  })

  it('fills the fields of a form under a base the same way', async () => {
    const based = await testSite({ root: 'tests/fixtures/form-once', config: { base: '/shop' } })
    const { html } = await based.visit('/shop/')

    expect(html).toContain('action="/shop/_kay/action/src/routes/index.kay/save"')
    expect(html).toContain('value="Buy milk"')
  })
})

describe('the text a record gives a field', () => {
  const late = new Date(2026, 2, 4, 23, 30)

  it('is the local day, minute or time of a date, whatever its time or zone', () => {
    expect(formInitial({ at: late }, 'at', 'date')).toBe('2026-03-04')
    expect(formInitial({ at: late }, 'at', 'datetime-local')).toBe('2026-03-04T23:30')
    expect(formInitial({ at: late }, 'at', 'time')).toBe('23:30')
    expect(formInitial({ at: new Date(Date.UTC(2026, 2, 4)) }, 'at')).toBe('2026-03-04')
  })

  it('ticks a box for true, or a list holding its value, and no other truthy value', () => {
    expect(formInitialChecked({ done: true }, 'done')).toBe(true)
    expect(formInitialChecked({ done: 'yes' }, 'done')).toBe(false)
    expect(formInitialChecked({ done: 1 }, 'done')).toBe(false)
    expect(formInitialChecked({ tags: ['a', 'c'] }, 'tags', 'c')).toBe(true)
    expect(formInitialChecked({ tags: ['a', 'c'] }, 'tags', 'b')).toBe(false)
    expect(formInitialChecked({ kind: 2 }, 'kind', '2')).toBe(true)
  })
})

describe('forms sharing one action', () => {
  const keys = (html: string) => [...html.matchAll(/name="kay_form" value="([^"]+)"/g)].map(match => match[1]!)

  it('give each form its own key, a repeated form one apiece', async () => {
    const { html } = await site.visit('/many')
    const found = keys(html)

    expect(found).toHaveLength(5)
    expect(new Set(found).size).toBe(5)
  })

  it('refill only the form that posted, in a loop too', async () => {
    const { html } = await site.visit('/many')
    const [, second, , middle] = keys(html)
    const refused = await site.submit(edit, { title: 'ab', kay_form: second }, { from: '/many' })

    expect(refused.html.match(/value="ab"/g)).toHaveLength(1)
    expect(refused.html).toContain('value="First"')
    expect(refused.html).not.toContain('value="Second"')

    const row = await site.submit(edit, { title: 'ab', kay_form: middle }, { from: '/many' })

    expect(row.html).toContain('value="A"')
    expect(row.html).toContain('value="C"')
    expect(row.html).not.toContain('value="B"')
    expect(row.html).toContain('value="Second"')
  })

  it('all refill from a post that names no form', async () => {
    const refused = await site.submit(edit, { title: 'ab' }, { from: '/many' })

    expect(refused.html.match(/value="ab"/g)).toHaveLength(5)
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('an island form given a record', () => {
  it('hydrates the server\'s markup, fills a field the island draws later, and keeps a refused post\'s values', async () => {
    const { html } = await site.visit('/island')

    expect(html).toContain('value="Walk dog"')

    await using page = await site.open('/island', { path })

    expect(await page.value('form.island input[name=title]')).toBe('Walk dog')
    expect(await page.evaluate(() => (document.querySelector('form.island input[name=done]') as HTMLInputElement).checked)).toBe(true)

    await page.click('button.show')
    await page.waitFor('input.late')

    expect(await page.value('input.late')).toBe('Walk dog')
    expect(page.errors).toEqual([])

    const refused = await site.submit(rename, { title: 'ab' }, { from: '/island' })

    expect(refused.html).toContain('value="ab"')
    expect(refused.html).not.toContain('Walk dog')
  })

  it('starts a textarea from the record over its own text, in the server\'s markup and in a field drawn later', async () => {
    const { html } = await site.visit('/island')

    expect(html).toContain('>from the record</textarea>')

    await using page = await site.open('/island', { path })

    expect(await page.value('form.island textarea.note')).toBe('from the record')
  })

  it('fills a field from a record that changes until the visitor edits it', async () => {
    await using page = await site.open('/island', { path })

    expect(await page.value('input.live')).toBe('Rex')

    await page.click('button.next')
    await page.waitFor('input.live')

    expect(await page.value('input.live')).toBe('Fido')

    await page.fill('input.live', 'typed')
    await page.evaluate(() => (document.querySelector('button.next') as HTMLButtonElement).click())

    expect(await page.value('input.live')).toBe('typed')
    expect(page.errors).toEqual([])
  })
})
