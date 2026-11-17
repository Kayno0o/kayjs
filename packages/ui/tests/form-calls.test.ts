import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { signal } from 'kay'
import { checkSent } from '../src/form-calls'

const src = (name: string) => readFileSync(join(import.meta.dir, '../src', name), 'utf8')

// A page whose forms are not sent yet must not carry the code that sends and reports them, nor the toast it reports with.
test('Form, FormDialog and SaveForm reach the sending code only through form-calls, which imports it on first use', () => {
  for (const name of ['form.kay', 'form-dialog.kay', 'save-form.kay']) {
    expect(src(name), name).not.toMatch(/from '\.\/forms(-send)?'/)
    expect(src(name), name).toContain('from \'./form-calls\'')
  }

  expect(src('form-calls.ts')).not.toMatch(/^import [^t].*from '\.\/forms-send'/m)
  expect(src('form-calls.ts')).toContain('import(\'./forms-send\')')
  expect(src('form-context.ts')).not.toContain('toast')
})

test('a send marks the form as being checked at once, before the code that checks it has loaded', async () => {
  const checking = signal(false)
  const form = { querySelectorAll: () => [] } as unknown as HTMLFormElement
  const action = { form: { validate: async () => true, failed: () => undefined } }
  const sent = checkSent(form, action, signal<Record<string, string>>({}), 'Could not save', checking)

  expect(checking()).toBe(true)
  expect(await sent).toBe(true)
  expect(checking()).toBe(false)
})
