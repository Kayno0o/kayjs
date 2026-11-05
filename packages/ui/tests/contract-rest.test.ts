import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC = join(import.meta.dir, '../src')
// The props a component does not name: a rest element of the destructured props, or `without(props, ...)` where the component reads them through one name.
const TAKES_REST = /\.\.\.\w+\s*\}\s*=\s*props\b|=\s*without\(/
// A spread of a variable in the template, such as `div({...rest} part="root")`; a constant like `{...OUTSIDE}` is no rest.
const SPREADS = /\{\.\.\.\(?\s*[a-z]/

// Components an app places on the page take `id`, `data-*` and `aria-*` through the props they do not name, spread on one element of their template.
const components = readdirSync(SRC).filter(file => file.endsWith('.kay'))

describe('every component takes the attributes of its root element', () => {
  for (const file of components) {
    it(file, () => {
      const source = readFileSync(join(SRC, file), 'utf8')
      const template = source.slice(source.indexOf('\n---', 4))

      expect(TAKES_REST.test(source), `${file} keeps no \`...rest\` of its props`).toBe(true)
      expect(SPREADS.test(template), `${file} spreads no rest in its template`).toBe(true)
    })
  }
})
