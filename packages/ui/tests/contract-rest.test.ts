import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC = join(import.meta.dir, '../src')
// The props a component does not name: a rest element of the destructured props, or the variable `without(props, ...)` is assigned to where the component reads them through one name.
const REST_ELEMENT = /\.\.\.(\w+)\s*\}\s*=\s*props\b/
const WITHOUT = /const\s+(\w+)\s*=\s*without\(/

// Components an app places on the page take `id`, `data-*` and `aria-*` through the props they do not name, spread on one element of their template.
const components = readdirSync(SRC).filter(file => file.endsWith('.kay'))

describe('every component takes the attributes of its root element', () => {
  for (const file of components) {
    it(file, () => {
      const source = readFileSync(join(SRC, file), 'utf8')
      const name = REST_ELEMENT.exec(source)?.[1] ?? WITHOUT.exec(source)?.[1]

      expect(name, `${file} keeps no \`...rest\` of its props`).toBeDefined()

      // The rest, or a variable it was assigned to such as `const handedOn = rest as ...`.
      const names = [name!, ...[...source.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*${name}\\b`, 'g'))].map(match => match[1]!)]
      const template = source.slice(source.indexOf('\n---', 4))

      expect(new RegExp(`\\.\\.\\.\\(?\\s*(?:${names.join('|')})\\b`).test(template), `${file} never spreads \`${name}\` in its template`).toBe(true)
    })
  }
})
