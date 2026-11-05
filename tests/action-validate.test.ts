import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { action } from '../src/runtime/action'
import { actionStub } from '../src/runtime/action-call'
import { resetWords } from '../src/runtime/words.client'
import { formsScript } from '../src/server/forms'

// The schema a page's forms carry to the browser, and the form the visitor fills in.
const schema = t.Object({
  title: t.String({ minLength: 3, error: 'Three letters at least' }),
  slug: t.String({ pattern: '^[a-z]+$' }),
  count: t.Number({ minimum: 1 }),
  photo: t.File(),
})

function page(fields: Record<string, string>, extra = ''): HTMLFormElement {
  const submitted = action(schema, () => undefined)

  ;(submitted as { url: string }).url = '/act'
  document.head.innerHTML = formsScript(new Set([submitted]))
  document.body.innerHTML = `<form>${Object.entries(fields).map(([name, value]) => `<input name="${name}" value="${value}">`).join('')}${extra}</form>`

  return document.querySelector('form')!
}

describe('action.validate in the browser', () => {
  beforeAll(() => GlobalRegistrator.register())
  afterAll(async () => GlobalRegistrator.unregister())
  beforeEach(() => {
    resetWords()
    document.head.innerHTML = ''
    document.body.innerHTML = ''
  })

  it('writes the messages the server would give into error(field) and failed(), reporting no bubble', async () => {
    const form = page({ title: 'ab', slug: 'A1', count: '0' })
    const add = actionStub('/act') as unknown as { validate: (form: HTMLFormElement, field?: string) => Promise<boolean>, error: (field?: string) => string | undefined, failed: () => { status: number, errors: Record<string, string> } | undefined }

    expect(await add.validate(form)).toBe(false)
    expect([add.error('title'), add.error('slug'), add.error('count'), add.error('photo')]).toEqual(['Three letters at least', 'Expected string to match \'^[a-z]+$\'', 'Expected number to be greater or equal to 1', undefined])
    expect(add.failed()?.status).toBe(422)
    expect([...form.querySelectorAll('input')].map(input => input.validationMessage)).toEqual(['', '', ''])
  })

  it('checks one field alone, replacing its message and keeping the others', async () => {
    const form = page({ title: 'ab', slug: 'A1', count: '2' })
    const add = actionStub('/act') as unknown as { validate: (form: HTMLFormElement, field?: string) => Promise<boolean>, error: (field?: string) => string | undefined }

    expect(await add.validate(form, 'title')).toBe(false)
    expect([add.error('title'), add.error('slug')]).toEqual(['Three letters at least', undefined])

    expect(await add.validate(form, 'slug')).toBe(false)
    expect([add.error('title'), add.error('slug')]).toEqual(['Three letters at least', 'Expected string to match \'^[a-z]+$\''])

    form.querySelector<HTMLInputElement>('[name="title"]')!.value = 'abc'
    expect(await add.validate(form, 'title')).toBe(true)
    expect([add.error('title'), add.error('slug')]).toEqual([undefined, 'Expected string to match \'^[a-z]+$\''])
  })

  it('clears every message once the form is accepted', async () => {
    const form = page({ title: 'ab', slug: 'a', count: '2' })
    const add = actionStub('/act') as unknown as { validate: (form: HTMLFormElement) => Promise<boolean>, failed: () => unknown }

    expect(await add.validate(form)).toBe(false)
    form.querySelector<HTMLInputElement>('[name="title"]')!.value = 'abc'
    expect(await add.validate(form)).toBe(true)
    expect(add.failed()).toBeUndefined()
  })

  it('leaves a file, a hidden field and a field the form lacks to the server', async () => {
    const form = page({ slug: 'a', count: '2' }, '<input type="file" name="photo"><input type="hidden" name="kay_since" value="x">')
    const add = actionStub('/act') as unknown as { validate: (form: HTMLFormElement) => Promise<boolean>, error: (field?: string) => string | undefined }

    expect(await add.validate(form)).toBe(true)
    expect([add.error('title'), add.error('photo')]).toEqual([undefined, undefined])
  })

  it('accepts a form whose page holds no schema for the action, writing nothing', async () => {
    const form = page({ title: 'ab', slug: 'a', count: '2' })
    const other = actionStub('/other') as unknown as { validate: (form: HTMLFormElement) => Promise<boolean>, failed: () => unknown }

    expect(await other.validate(form)).toBe(true)
    expect(other.failed()).toBeUndefined()
  })
})
