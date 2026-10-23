import type { Attribute, ElementNode } from '../../../src/compiler/ast'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { elementsIn, partAttribute } from '../../../src/compiler/ast'
import { parseKay } from '../../../src/compiler/parser'

const SRC = join(import.meta.dir, '../src')
const FOLDERS = ['', 'internal', 'shell']

// Elements no app styles: the compiler's own `slot`, a data `script`, the native children of a list or media element, a hidden input and the control of a FormField, which the field's look draws.
const NATIVE_CHILDREN = new Set(['slot', 'option', 'datalist', 'track', 'script'])

// Structure that is hidden or only layout, by file and tag with how many there are: the data table a chart keeps for screen readers, a date grid's head and body, a Table's spacer and empty rows and a toast's message in its live region.
const STRUCTURE: Record<string, Record<string, number>> = {
  'date-input.kay': { thead: 1, tbody: 1 },
  'line-chart.kay': { table: 1, caption: 1, thead: 1, tbody: 1, tr: 2, th: 3, td: 3 },
  'table.kay': { tr: 2, td: 2 },
  'toaster.kay': { span: 2 },
}

// The states ARIA has an attribute for: a `data-*` of the same name is a second source of truth, so it stays out unless listed here with the reason it says something else.
const ARIA_STATES = ['busy', 'checked', 'current', 'disabled', 'expanded', 'hidden', 'invalid', 'pressed', 'readonly', 'required', 'selected']

// A generic name says nothing about the state it holds.
const GENERIC_STATE = new Set(['data-state', 'data-status', 'data-open', 'data-active'])

interface Template {
  file: string
  source: string
  elements: ElementNode[]
  top: ElementNode[]
}

function read(file: string, source: string): Template {
  const { template } = parseKay(source)

  return { file, source, elements: [...elementsIn(template)], top: template.filter((node): node is ElementNode => node.kind === 'element') }
}

const templates: Template[] = FOLDERS.flatMap(folder => readdirSync(join(SRC, folder)).filter(name => name.endsWith('.kay')).sort().map(name => read(folder === '' ? name : `${folder}/${name}`, readFileSync(join(SRC, folder, name), 'utf8'))))

const nameOf = (attribute: Attribute, source: string) => attribute.kind === 'spread' ? undefined : source.slice(attribute.name.start, attribute.name.end)

const attributesOf = (element: ElementNode, source: string) => new Set(element.attributes.map(attribute => nameOf(attribute, source)))

const hasValue = (element: ElementNode, source: string, name: string, value: string) => element.attributes.some(attribute => attribute.kind === 'static' && nameOf(attribute, source) === name && attribute.text === value)

const place = (template: Template, element: ElementNode) => `${template.file}:${template.source.slice(0, element.start).split('\n').length} ${element.name}`

// A template with one top element is that element's root, which `class` reaches without a mark.
function unmarked(template: Template): string[] {
  const { file, source, elements, top } = template
  const structure = Object.entries(STRUCTURE[file] ?? {})
  const left = new Map(structure)

  const found = elements.filter((element) => {
    if (element.component || (top.length === 1 && top[0] === element) || NATIVE_CHILDREN.has(element.name))
      return false

    const names = attributesOf(element, source)

    if (partAttribute(element, source) !== undefined || names.has('data-part') || names.has('field'))
      return false

    if (element.name === 'input' && hasValue(element, source, 'type', 'hidden'))
      return false

    const room = left.get(element.name)

    if (room === undefined || room === 0)
      return true

    left.set(element.name, room - 1)

    return false
  }).map(element => place(template, element))

  const stale = [...left].filter(([, room]) => room > 0).map(([tag, room]) => `${file}: ${room} fewer ${tag} than STRUCTURE lists`)

  return [...found, ...stale]
}

// The attributes of an element that stand for a state in a way the contract refuses.
function badStates(template: Template): string[] {
  const { source, elements } = template
  const found: string[] = []

  for (const element of elements) {
    const names = attributesOf(element, source)

    for (const name of names) {
      if (name === undefined)
        continue

      if (GENERIC_STATE.has(name))
        found.push(`${place(template, element)} ${name} is no named state`)

      for (const state of ARIA_STATES) {
        if (name === `data-${state}`)
          found.push(`${place(template, element)} ${name} repeats ${state === 'disabled' ? 'aria-disabled or disabled' : `aria-${state}`}`)
      }
    }
  }

  return found
}

describe('the contract of every kayjs-ui component', () => {
  it('reads the component templates', () => {
    expect(templates.length).toBeGreaterThan(80)
    expect(templates.some(({ file }) => file.startsWith('internal/'))).toBe(true)
  })

  it('marks every inner element an app could style with a part', () => {
    expect(templates.flatMap(unmarked)).toEqual([])
  })

  it('carries a state in an ARIA attribute or a named data attribute, never a data-state or a bare data-* of an ARIA state', () => {
    expect(templates.flatMap(badStates)).toEqual([])
  })

  it('catches an unmarked element, a data-state and a data-* repeating ARIA', () => {
    const template = read('x.kay', 'div(part="root" data-state="open" data-expanded)\n  span {label}\n  p(part="x") {label}\n')

    expect(unmarked(template)).toEqual(['x.kay:2 span'])
    expect(badStates(template)).toEqual(['x.kay:1 div data-state is no named state', 'x.kay:1 div data-expanded repeats aria-expanded'])
  })
})
