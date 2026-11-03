import { join } from 'node:path'
import { Glob } from 'bun'
import { expect, test } from 'bun:test'
import * as look from '../src/field-look'

const SRC = join(import.meta.dir, '..', 'src')
const SPACES = /\s+/
const MULTIPLIER = /\*\s*([\d.]+)\s*\*\s*var\(--density\)/g

test('the field look is written once, in field-look.ts', async () => {
  const copies: string[] = []

  for (const file of new Glob('*.{kay,ts}').scanSync(SRC)) {
    if (file !== 'field-look.ts' && (await Bun.file(join(SRC, file)).text()).includes('[border:var(--border-width)_solid_var(--color-input)]'))
      copies.push(file)
  }

  expect(copies).toEqual([])
  expect(look.FIELD_LOOK).toContain('aria-invalid:border-danger')
})

test('the stylesheet colours an invalid field and sizes a small and a large one', async () => {
  const css = await Bun.file(join(SRC, 'theme.css')).text()

  expect(css).toContain('.kui-field-input:is([aria-invalid=\'true\'], [data-refused=\'true\'])')
  expect(css).toContain('.kui-form-field :where(input, select, textarea)[aria-invalid=\'true\']')
  expect(css).toContain('.kui-field-input:where([data-size=\'sm\'])')
  expect(css).toContain('.kui-field-input:where([data-size=\'lg\'])')
})

// Tailwind reads class names as text in the source, so a class built at run time, as by `replaceAll`, is never generated.
test('every class a field look constant holds is written out in field-look.ts', async () => {
  const source = await Bun.file(join(SRC, 'field-look.ts')).text()
  const built: string[] = []

  for (const [name, value] of Object.entries(look)) {
    if (typeof value === 'string' && name === name.toUpperCase()) {
      for (const token of value.split(SPACES)) {
        if (!source.includes(token))
          built.push(`${name}: ${token}`)
      }
    }
  }

  expect(built).toEqual([])
  expect(look.FIELD_SELECT_BOX).toContain('data-[size=sm]:pl-[calc(var(--spacing)*1.75*var(--density))]')
  expect(look.FIELD_SELECT_BOX).not.toContain('data-[size=sm]:px-')
})

test('the sizes of the field utilities are the numbers of the stylesheet rules', async () => {
  const css = await Bun.file(join(SRC, 'theme.css')).text()

  for (const size of ['sm', 'lg']) {
    const from = css.indexOf(`.kui-field-input:where([data-size='${size}'])`)
    const rule = css.slice(from, css.indexOf('}', from))
    const utilities = look.FIELD_SIZES.split(SPACES).filter(token => token.startsWith(`data-[size=${size}]:`)).join(' ')

    expect(rule, size).not.toBe('')
    expect([...utilities.matchAll(MULTIPLIER)].map(match => match[1]).toSorted(), size).toEqual([...rule.matchAll(MULTIPLIER)].map(match => match[1]).toSorted())
    expect(utilities).toContain(`text-${size === 'sm' ? 'xs' : 'base'}`)
    expect(rule).toContain(`var(--text-${size === 'sm' ? 'xs' : 'base'})`)
  }
})
