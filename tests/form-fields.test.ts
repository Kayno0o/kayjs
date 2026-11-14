import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { testSite } from '../src/test'

const root = 'tests/fixtures/form-fields'
const site = await testSite({ root, islands: false })
const { edit } = await import(join(import.meta.dir, 'fixtures/form-fields/src/routes/index.kay')) as { edit: Action<Record<string, string | boolean>, unknown> }
const { bump } = await import(join(import.meta.dir, 'fixtures/form-fields/src/routes/lone.kay')) as { bump: Action<Record<string, string>, unknown> }

const ACTION = '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const save = action(t.Object({ title: t.String({ minLength: 3, maxLength: 40 }), done: t.Optional(t.Boolean()) }), () => {})\n---\n'

function compile(template: string, output?: 'html' | 'dom') {
  return compileKay(`${ACTION}${template}`, 'page.kay', { check: output === undefined, output })
}

const messages = (template: string) => compile(template).diagnostics.map(diagnostic => diagnostic.message)

describe('a bare control in a component given a field', () => {
  it('takes the name, the schema\'s constraints and the record\'s value', async () => {
    const { html } = await site.visit('/')

    expect(html).toContain('<input id="edit-title" name="title" required minlength="3" maxlength="40" value="Buy milk">')
    expect(html).toContain('<input name="done" type="checkbox" checked>')
    expect(html).toContain('<select name="size" maxlength="10">')
    expect(html).toContain('<option value="m" selected>Medium</option>')
  })

  it('leaves a control that names itself alone', async () => {
    const { html } = await site.visit('/')

    expect(html).toContain('<input name="other">')
  })

  it('marks it invalid and refills it after a refused post', async () => {
    const refused = await site.submit(edit, { title: 'ab', size: 's' }, { from: '/' })

    expect(refused.status).toBe(422)
    expect(refused.html).toContain('<input id="edit-title" name="title"')
    expect(refused.html).toContain('value="ab" aria-invalid="true"')
    expect(refused.html).toContain('<option value="s" selected>Small</option>')
  })

  it('writes the same name on the server and in the browser, and checks it against the action', () => {
    const template = 'form(action={save})\n  Wrap(field="title")\n    input\n'

    for (const output of ['html', 'dom'] as const)
      expect(compile(template, output).tsx).toContain('name=\\"title\\"')

    expect(compile(template).tsx).toContain('<input name={KayField((save), "title")} />')
    expect(compile(template).tsx).toContain('field={KayField((save), "title")}')
  })

  it('stops at a form of its own and at a component that is one', () => {
    const nested = compile('form(action={save})\n  Wrap(field="title")\n    form(action={save})\n      input\n', 'html').tsx
    const component = compile('form(action={save})\n  Wrap(field="title")\n    Form(action={save})\n      input\n', 'html').tsx

    expect(nested.match(/name=\\"title\\"/g)).toBeNull()
    expect(component.match(/name=\\"title\\"/g)).toBeNull()
  })

  it('stops at any nested form and at a component with a computed field', () => {
    const plain = compile('form(action={save})\n  Wrap(field="title")\n    form(method="get")\n      input\n', 'html').tsx
    const computed = compile('form(action={save})\n  Wrap(field="title")\n    Wrap(field={other})\n      input\n', 'html').tsx

    expect(plain.match(/name=\\"title\\"/g)).toBeNull()
    expect(computed.match(/name=\\"title\\"/g)).toBeNull()
  })

  it('names nothing outside a form', () => {
    expect(compile('Wrap(field="title")\n  input\n', 'html').tsx).not.toContain('name=')
  })
})

describe('a label given a field', () => {
  it('writes its for, and the id of the one control of that field', async () => {
    const { html } = await site.visit('/')

    expect(html).toContain('<label for="edit-title">Name</label>')
    expect(html).toContain('<label for="edit-note">Note</label>')
    expect(html).toContain('<textarea id="edit-note" name="note"')
  })

  it('is a label of the control for the accessibility lint, and checks its field against the action', () => {
    const codes = (template: string) => compile(template).diagnostics.map(diagnostic => diagnostic.code)

    expect(codes('form(action={save})\n  label(field="title") Title\n  input(field="title")\n')).not.toContain('missing-label')
    expect(compile('form(action={save})\n  label(field="nope") T\n  input(field="title")\n').tsx).toContain('for={KayField((save), "nope")}')
  })

  it('needs exactly one control, outside a loop of ids of its own, and writes no id beside it', () => {
    expect(messages('form(action={save})\n  label(field="title") T\n')).toContain('A label\'s `field` points at the one control of that field, and this form has 0')
    expect(messages('form(action={save})\n  label(field="title") T\n  input(field="title")\n  input(field="title")\n')).toContain('A label\'s `field` points at the one control of that field, and this form has 2')
    expect(messages('form(action={save})\n  label(field="title") T\n  input(field="title" id="x")\n').some(message => message.includes('gives this field its id'))).toBe(true)
    expect(messages('form(action={save})\n  label(field="title" for="x") T\n  input(field="title")\n')).toContain('A label has `field` or `for`, not both')
    expect(messages('label(field="title") T\n')).toContain('`field` on a label names a field of a form posting to an action, so it sits inside one')
  })

  it('gives the id to a control with a computed type or a spread, and counts the innermost component\'s bare control once', () => {
    const typed = compile('form(action={save})\n  label(field="title") T\n  input(field="title" type={kind})\n', 'html').tsx
    const spread = compile('form(action={save})\n  label(field="title") T\n  input(field="title" {...rest})\n', 'html').tsx
    const nested = compile('form(action={save})\n  label(field="title") T\n  Wrap(field="done")\n    Wrap(field="title")\n      input\n', 'html').tsx

    expect(typed).toContain('id=\\"save-title\\"')
    expect(spread).not.toContain('id=\\"save-title\\"')
    expect(messages('form(action={save})\n  label(field="title") T\n  input(field="title" {...rest})\n')).toContain('A label\'s `field` points at the one control of that field, and this form has 0')
    expect(nested).toContain('id=\\"save-title\\"')
    expect(messages('form(action={save})\n  label(field="title") T\n  Wrap(field="done")\n    Wrap(field="title")\n      input\n')).not.toContain('A label\'s `field` points at the one control of that field, and this form has 2')
  })

  it('points the same on a page under a base path', async () => {
    const mounted = await testSite({ root, islands: false, base: '/blog' })
    const { html } = await mounted.visit('/blog/')

    expect(html).toContain('<label for="edit-title">Name</label>')
  })
})

describe('a button given an action, alone', () => {
  it('is a form of its own on a static page, one per button', async () => {
    const { html } = await site.visit('/lone')

    expect(html.match(/<form style="display:contents"/g)).toHaveLength(2)
    expect(html).toContain('<button class="one">Add one</button>')
  })

  it('posts through its form, with the arguments of its call', async () => {
    await site.submit(bump, {}, { from: '/lone' })
    await site.submit(bump, { by: '2' }, { from: '/lone' })

    expect((await site.visit('/lone')).html).toContain('<p class="tally">3</p>')
  })

  it('wires the form of an island as a form with an action, and a form already around it stays one', () => {
    const island = compile('script\n  import { signal } from \'kay\'\n  const n = signal(0)\nbutton(type="button" onClick={() => n += 1}) {n()}\nbutton.go(action={save}) Go\n', 'dom').tsx

    expect(island).toContain('KayFormAction((save))')
    expect(island).toContain('display:contents')
    expect(messages('form(action={save})\n  button(action={save}) Go\n')).toContain('A button with `action` is a form of its own, so it sits outside one')
    expect(messages('button(action={save}) Go\n')).not.toContain('A button with `action` is a form of its own, so it sits outside one')
  })
})
