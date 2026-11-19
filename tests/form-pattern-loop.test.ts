import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

const file = join(process.cwd(), 'row.kay')
const head = '---\nimport type { Action } from \'kay\'\nconst { cancel, xs, rows } = props<{ cancel: Action, xs: [string, number][], rows: { id: string }[] }>()\n---\n'

const shapes: Record<string, string> = {
  'a bare error beside an array pattern loop': 'form(action={cancel})\n  error\nfor [a, b] of xs key={a}\n  p {b}\n',
  'a named error beside an array pattern loop': 'form(action={cancel})\n  error title\nfor [a, b] of xs\n  p {b}\n',
  'a bare error beside an object pattern loop': 'form(action={cancel})\n  error\nfor { id } of rows key={id}\n  p {id}\n',
  'a pending line beside a pattern loop': 'form(action={cancel})\n  pending\n    p Saving\nfor [a] of xs\n  p {a}\n',
  'a form inside a pattern loop': 'for [a] of xs key={a}\n  form(action={cancel})\n    error\n',
  'a pattern loop inside the form': 'form(action={cancel})\n  for [a] of xs key={a}\n    p {a}\n  error\n',
}

describe('a form in a file with a loop over a pattern', () => {
  for (const [name, template] of Object.entries(shapes)) {
    for (const output of ['html', 'dom'] as const) {
      it(`reads the form around ${name}, built for ${output}`, () => {
        const { tsx } = compileKay(head + template, file, { output, hydratable: true })

        expect(tsx).not.toContain('KayFormHere')
        expect(tsx).toContain('(__props.cancel)')
      })
    }
  }

  it('builds the form around a field as it does beside a plain loop', () => {
    const field = 'form(action={cancel})\n  input(field="title")\n  error title\n'
    const form = (loop: string): string => compileKay(`${head}${field}${loop}`, file, { output: 'html' }).tsx.match(/KayFormScope\(.*?"<\/form>"/)![0]

    expect(form('for [a] of xs key={a}\n  p {a}\n')).toBe(form('for a of xs key={a}\n  p {a}\n'))
  })

  it('still leaves an error outside every form to the form its function renders in', () => {
    const { tsx } = compileKay(`${head}error title\nfor [a] of xs key={a}\n  p {a}\n`, file, { output: 'html' })

    expect(tsx).toMatch(/import \{[^}]*formHere as KayFormHere[^}]*\} from 'kay\/internal'/)
  })
})
