import type { Action } from '../src/runtime'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { browserPath, testSite } from '../src/test'

const site = await testSite({ root: 'tests/fixtures/form-once', browser: true })
const { save } = await import(join(import.meta.dir, 'fixtures/form-once/src/routes/index.kay')) as { save: Action<Record<string, string | boolean | string[]>, unknown> }
const { rename } = await import(join(import.meta.dir, 'fixtures/form-once/src/routes/island.kay')) as { rename: Action<Record<string, string | boolean>, unknown> }
const path = browserPath()

describe('a form given the record its fields start from', () => {
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
    expect(html).toContain('<input name="nick" maxlength="20" value="anon">')
    expect(html).not.toContain('values=')
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

    expect(server).toContain('KayFormInitial((todo), "title")')
    expect(server).toContain('KayFormInitialChecked((todo), "done", undefined)')
    expect(browser).toContain('KayFormInitial((todo), "title")')
    expect(browser).toContain('KayFormInitialChecked((todo), "done", undefined)')
  })

  it('leaves a field with a value of its own, and a form with no record, as written', () => {
    const own = compileKay('form(action={save} values={todo})\n  input(field="title" value="x")\n', 'page.kay', { output: 'dom' }).tsx
    const none = compileKay('form(action={save})\n  input(field="title")\n', 'page.kay', { output: 'html' }).tsx

    expect(own).not.toContain('KayFormInitial((todo), "title")')
    expect(none).not.toContain('Initial')
  })

  it('type-checks the record against the action\'s fields', () => {
    const { tsx } = compileKay('form(action={save} values={todo})\n  input(field="title")\n', 'page.kay', { check: true })

    expect(tsx).toContain('{...KayFormValues((save), (todo))}')
  })

  it('fills the fields of a form under a base the same way', async () => {
    const based = await testSite({ root: 'tests/fixtures/form-once', base: '/shop' })
    const { html } = await based.visit('/shop/')

    expect(html).toContain('action="/shop/_kay/action/src/routes/index.kay/save"')
    expect(html).toContain('value="Buy milk"')
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
})
