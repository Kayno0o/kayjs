import type { Action } from '../src/runtime/action'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { formChecked, formErrors, formScope, issueScope, postedChecked, postedValue, postedValues } from '../src/runtime/action'
import { ACTION } from '../src/runtime/action-shared'
import { submittedValues } from '../src/server/flash'
import { testSite } from '../src/test'

// An action whose last post was refused with `values`, as far as the readers of a refused post go.
function refused(values: Record<string, string> | undefined, protection?: object) {
  const target = (() => undefined) as unknown as Record<PropertyKey, unknown>

  target[ACTION] = true
  target.failed = () => values === undefined ? undefined : { values }
  target.protection = protection

  return target
}

function inside<T>(target: unknown, read: () => T): T {
  let found!: T

  formScope(target, () => {
    found = read()

    return ''
  })

  return found
}

describe('submittedValues', () => {
  it('keeps a field posted more than once as a JSON list under its name and []', () => {
    expect(submittedValues({ tags: ['a', 'b'], one: 'x', n: 3, on: true })).toEqual({ 'tags[]': '["a","b"]', 'one': 'x', 'n': '3', 'on': 'true' })
  })

  it('drops a secret, a nested value and a field literally named like a list', () => {
    expect(submittedValues({ 'password': 'p', 'nested': { a: 1 }, 'foo[]': 'x', 'ok': 'y' })).toEqual({ ok: 'y' })
    expect(submittedValues({ tags: [{ a: 1 }, 'b'] })).toEqual({ 'tags[]': '["b"]' })
  })

  it('has nothing for a body that is not an object', () => {
    expect(submittedValues(undefined)).toEqual({})
    expect(submittedValues('text')).toEqual({})
  })
})

describe('postedValue, postedChecked and postedValues', () => {
  it('read the refused post of the form being rendered, nothing outside it or without a refusal', () => {
    const target = refused({ 'x': 'one', 'yes': 'yes', 'list[]': '["a","b"]' })

    expect(postedValue('x')).toBeUndefined()
    expect(inside(target, () => postedValue('x'))).toBe('one')
    expect(inside(target, () => postedValue('missing'))).toBeUndefined()
    expect(inside(refused(undefined), () => postedValue('x'))).toBeUndefined()
    expect(inside('/plain', () => postedValue('x'))).toBeUndefined()
    expect(inside(target, () => postedValue(''))).toBeUndefined()
    expect(inside(target, () => postedValue(undefined))).toBeUndefined()
  })

  it('answer for the innermost form, then for the outer one again', () => {
    const outer = refused({ x: 'outer' })
    const inner = refused({ x: 'inner' })
    const seen: (string | undefined)[] = []

    formScope(outer, () => {
      seen.push(postedValue('x'))
      formScope(inner, () => {
        seen.push(postedValue('x'))

        return ''
      })
      seen.push(postedValue('x'))

      return ''
    })
    expect(seen).toEqual(['outer', 'inner', 'outer'])
    expect(postedValue('x')).toBeUndefined()
  })

  it('end a scope that throws', () => {
    expect(() => formScope(refused({ x: '1' }), () => {
      throw new Error('boom')
    })).toThrow('boom')
    expect(postedValue('x')).toBeUndefined()
  })

  it('give the list of a field posted more than once, one value, none, or nothing for a corrupt list', () => {
    const target = refused({ 'list[]': '["a","b"]', 'one': 'z', 'bad[]': '{nope', 'notlist[]': '"x"', 'other': 'o' })

    expect(inside(target, () => postedValues('list'))).toEqual(['a', 'b'])
    expect(inside(target, () => postedValues('one'))).toEqual(['z'])
    expect(inside(target, () => postedValues('none'))).toEqual([])
    expect(inside(target, () => postedValues('bad'))).toEqual([])
    expect(inside(target, () => postedValues('notlist'))).toEqual([])
    expect(inside(refused({}), () => postedValues('list'))).toBeUndefined()
    expect(inside(refused(undefined), () => postedValues('list'))).toBeUndefined()
  })

  it('tell a box ticked among several of one name, whichever way the post spelled them', () => {
    const target = refused({ 'yes[]': '["a","b"]', 'single': 'a', 'flag': 'on', 'off': 'false', 'other': 'x' })

    expect(inside(target, () => postedChecked('yes', 'b'))).toBe(true)
    expect(inside(target, () => postedChecked('yes', 'c'))).toBe(false)
    expect(inside(target, () => postedChecked('single', 'a'))).toBe(true)
    expect(inside(target, () => postedChecked('flag'))).toBe(true)
    expect(inside(target, () => postedChecked('off'))).toBe(false)
    expect(inside(target, () => postedChecked('missing'))).toBe(false)
    expect(inside(refused({}), () => postedChecked('flag'))).toBeUndefined()
    expect(formChecked(target, 'yes', 'a')).toBe(true)
  })

  it('leave out the honeypot', () => {
    const target = refused({ nectar: 'bot' }, { honeypot: 'nectar' })

    expect(inside(target, () => postedValue('nectar'))).toBeUndefined()
  })
})

const site = await testSite({ root: 'tests/fixtures/posted' })
const routes = async () => await import(join(import.meta.dir, 'fixtures/posted/src/routes/index.kay')) as { first: Action<{ x: string }, string> }

describe('a component inside a form posting to an action', () => {
  const find = (html: string, id: string) => html.match(new RegExp(`<span id="${id}"[^>]*>`))?.[0]

  it('shows the refused post only in the form it was posted to, however forms nest or follow', async () => {
    const { first } = await routes()
    const { html } = await site.submit(first, { x: 'abc', password: 'hunter2', nectar: '', yes: ['a', 'yes'] } as never, { from: '/' })

    expect(find(html, 'a-x')).toContain('data-text="abc"')
    expect(find(html, 'a-after')).toContain('data-text="abc"')
    expect(find(html, 'inner-x')).not.toContain('data-text')
    expect(find(html, 'b-x')).not.toContain('data-text')
    expect(find(html, 'plain-x')).not.toContain('data-text')
    expect(find(html, 'outside-x')).not.toContain('data-text')
    expect(find(html, 'a-yes')).toContain('data-ticked="true"')
    expect(find(html, 'a-yes')).toContain('data-list="[&quot;a&quot;,&quot;yes&quot;]"')
  })

  it('never echoes a secret or the honeypot, and does not read a field named like a list', async () => {
    const { first } = await routes()
    const { html } = await site.submit(first, { 'x': 'abc', 'password': 'hunter2', 'nectar': 'bot', 'foo[]': 'x' } as never, { from: '/' })

    expect(html).not.toContain('hunter2')
    expect(find(html, 'a-password')).not.toContain('data-text')
    expect(find(html, 'a-nectar')).not.toContain('data-text')
  })

  it('escapes what was posted in text, attributes and a textarea', async () => {
    const { first } = await routes()
    const hostile = '"><script>alert(1)</script></textarea><b>'
    const { html } = await site.submit(first, { x: hostile, password: 'x'.repeat(50) } as never, { from: '/' })

    expect(html).not.toContain('<script>alert(1)')
    expect(html).not.toContain('</textarea><b>')
    expect(html).toContain('&lt;script>alert(1)&lt;/script>&lt;/textarea>')
    expect(html).toMatch(/<input id="a-x-input" name="x" value="&quot;>&lt;script>/)
  })

  it('works under a base', async () => {
    const { first } = await routes()

    const { html } = await site.submit(first, { x: 'abc' } as never, { from: '/' })

    expect(find(html, 'a-x')).toContain('data-text="abc"')

    expect(find((await site.visit('/')).html, 'a-x')).not.toContain('data-text')
  })
})

describe('formErrors', () => {
  it('reads the messages of the action of the form being rendered, fixed when it was taken', () => {
    const target = refused(undefined) as unknown as Record<string, unknown>

    target.error = (field: string) => field === 'title' ? 'Too short' : undefined

    const read = inside(target, () => formErrors())

    expect(read('title')).toBe('Too short')
    expect(read('slug')).toBeUndefined()
    expect(formErrors()('title')).toBeUndefined()
  })

  it('answers the innermost form and nothing for a plain URL form', () => {
    const outer = refused(undefined) as unknown as Record<string, unknown>
    const inner = refused(undefined) as unknown as Record<string, unknown>

    outer.error = () => 'outer'
    inner.error = () => 'inner'
    expect(inside(outer, () => inside(inner, () => formErrors()('x')))).toBe('inner')
    expect(inside(outer, () => inside('/plain', () => formErrors()('x')))).toBeUndefined()
  })

  it('leaves a form in place for a component given a value that is no action, where a plain URL form shadows it', () => {
    const outer = refused(undefined) as unknown as Record<string, unknown>
    const read = (target: unknown, only: boolean) => formScope(outer, () => formScope(target, () => formErrors()('x'), only), false)

    outer.error = () => 'outer'

    expect(read({ label: 'Undo' }, true)).toBe('outer')
    expect(read('/plain', true)).toBe('outer')
    expect(read('/plain', false)).toBeUndefined()
  })

  it('pops the scope when the render throws', () => {
    const target = refused(undefined) as unknown as Record<string, unknown>

    target.error = () => 'kept'

    expect(() => formScope(target, () => {
      throw new Error('boom')
    })).toThrow('boom')
    expect(formErrors()('x')).toBeUndefined()
    expect(() => issueScope(target, () => {
      throw new Error('boom')
    })).toThrow('boom')
    expect(formErrors()('x')).toBeUndefined()
  })

  it('answers nothing inside an island\'s own template, though a page form encloses it', () => {
    const target = refused(undefined) as unknown as Record<string, unknown>

    target.error = () => 'page'

    expect(inside(target, () => issueScope(undefined, () => formErrors()('x')))).toBeUndefined()
    expect(inside(target, () => formErrors()('x'))).toBe('page')
  })
})
