import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

// A form without `confirm` must not ship the dialog: the question is a chunk of its own, imported once there is one to ask.
test('SaveForm imports Dialog only through the confirm chunk', () => {
  const source = readFileSync(join(import.meta.dir, '../src/save-form.kay'), 'utf8')

  expect(source).not.toMatch(/from '\.\/dialog\.kay'/)
  expect(source).toContain('import(\'./internal/save-confirm.kay\')')
  expect(readFileSync(join(import.meta.dir, '../src/internal/save-confirm.kay'), 'utf8')).toContain('from \'../dialog.kay\'')
})
