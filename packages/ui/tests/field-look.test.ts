import { join } from 'node:path'
import { Glob } from 'bun'
import { expect, test } from 'bun:test'
import { FIELD_LOOK } from '../src/field-look'

const SRC = join(import.meta.dir, '..', 'src')

test('the field look is written once, in field-look.ts', async () => {
  const copies: string[] = []

  for (const file of new Glob('*.{kay,ts}').scanSync(SRC)) {
    if (file !== 'field-look.ts' && (await Bun.file(join(SRC, file)).text()).includes('[border:var(--border-width)_solid_var(--color-input)]'))
      copies.push(file)
  }

  expect(copies).toEqual([])
  expect(FIELD_LOOK).toContain('aria-invalid:border-danger')
})

test('the stylesheet colours an invalid field and sizes a small and a large one', async () => {
  const css = await Bun.file(join(SRC, 'theme.css')).text()

  expect(css).toContain('.kui-field-input[aria-invalid=\'true\']')
  expect(css).toContain('.kui-form-field :where(input, select, textarea)[aria-invalid=\'true\']')
  expect(css).toContain('.kui-field-input:where([data-size=\'sm\'])')
  expect(css).toContain('.kui-field-input:where([data-size=\'lg\'])')
})
