import { readFileSync } from 'node:fs'
import { partNames, templateFacts, visitNodes } from '../../src/compiler/ast'
import { parseKay } from '../../src/compiler/parser'
import { analyzeScript } from '../../src/compiler/script'

export interface Part {
  name: string
  // The elements and components the part is written on, in order, `component` for a call whose own `class` takes the part's entry.
  on: { name: string, component: boolean }[]
  // The components this component hands the part's entry on to, as `part="root spinner"` does.
  handedTo: string[]
}

// The parts a component names, read with the compiler's own template facts, so they are the ones `kay check` knows: `root` included when the template has a single top element.
export function partsOfComponent(file: string): Part[] {
  const source = readFileSync(file, 'utf8')
  const parsed = parseKay(source)

  if (parsed.server !== undefined)
    return []

  const script = analyzeScript(source, parsed.script, [], [], parsed.module)
  const facts = templateFacts(parsed, script.recipe).parts

  if (facts === undefined)
    return []

  const parts = new Map<string, Part>([...facts.names.keys()].map(name => [name, { name, on: [], handedTo: facts.handed.get(name) ?? [] }]))

  visitNodes(parsed.template, (node) => {
    if (node.kind !== 'element')
      return

    const name = partNames(node, source)[0] ?? (node === facts.implicit ? 'root' : undefined)
    const part = name === undefined ? undefined : parts.get(name)

    if (part !== undefined && !part.on.some(found => found.name === node.name))
      part.on.push({ name: node.name, component: node.component })
  })

  return [...parts.values()].sort((a, b) => Number(b.name === 'root') - Number(a.name === 'root'))
}
