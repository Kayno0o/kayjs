import type { Attribute, ElementNode } from '../../../src/compiler/ast'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { elementsIn, partAttribute } from '../../../src/compiler/ast'
import { parseKay } from '../../../src/compiler/parser'

const SRC = join(import.meta.dir, '../src')

// Elements no app styles: the compiler's own `slot`, the native children of a list or media element, a hidden input and the control of a FormField, which the field's look draws.
const NATIVE_CHILDREN = new Set(['slot', 'option', 'datalist', 'track'])

// Structure that is hidden or only layout, by file and tag: the data table a chart keeps for screen readers, a date grid's head and body, a Table's spacer and empty rows and a toast's message in its live region.
const STRUCTURE: Record<string, readonly string[]> = {
  'date-input.kay': ['thead', 'tbody'],
  'line-chart.kay': ['table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td'],
  'table.kay': ['tr', 'td'],
  'toaster.kay': ['span'],
}

// The states ARIA has an attribute for: a `data-*` of the same name beside it would be a second source of truth.
const ARIA_STATES = ['busy', 'checked', 'current', 'disabled', 'expanded', 'hidden', 'invalid', 'pressed', 'readonly', 'required', 'selected']

// A generic name says nothing about the state it holds.
const GENERIC_STATE = new Set(['data-state', 'data-status', 'data-open', 'data-active'])

interface Template {
  file: string
  source: string
  elements: ElementNode[]
  top: Set<unknown>
}

const templates: Template[] = readdirSync(SRC).filter(name => name.endsWith('.kay')).sort().map((file) => {
  const source = readFileSync(join(SRC, file), 'utf8')
  const parsed = parseKay(source)

  return { file, source, elements: [...elementsIn(parsed.template)], top: new Set(parsed.template) }
})

const nameOf = (attribute: Attribute, source: string) => attribute.kind === 'spread' ? undefined : source.slice(attribute.name.start, attribute.name.end)

const attributesOf = (element: ElementNode, source: string) => new Set(element.attributes.map(attribute => nameOf(attribute, source)))

const hasValue = (element: ElementNode, source: string, name: string, value: string) => element.attributes.some(attribute => attribute.kind === 'static' && nameOf(attribute, source) === name && attribute.text === value)

// What this file leaves unmarked on purpose: the root, which `part="root"` or the single top element is, and the elements above.
function unmarked({ file, source, elements, top }: Template): string[] {
  const structure = STRUCTURE[file] ?? []

  return elements.filter((element) => {
    if (element.component || top.has(element) || NATIVE_CHILDREN.has(element.name) || structure.includes(element.name))
      return false

    const names = attributesOf(element, source)

    if (partAttribute(element, source) !== undefined || names.has('data-part') || names.has('field'))
      return false

    return !(element.name === 'input' && hasValue(element, source, 'type', 'hidden'))
  }).map(element => `${file}:${source.slice(0, element.start).split('\n').length} ${element.name}`)
}

// The attributes of an element that stand for a state in a way the contract refuses.
function badStates({ file, source, elements }: Template): string[] {
  const found: string[] = []

  for (const element of elements) {
    const names = attributesOf(element, source)
    const line = `${file}:${source.slice(0, element.start).split('\n').length} ${element.name}`

    for (const name of names) {
      if (name === undefined)
        continue

      if (GENERIC_STATE.has(name))
        found.push(`${line} ${name} is no named state`)

      for (const state of ARIA_STATES) {
        if (name === `data-${state}` && (names.has(`aria-${state}`) || (state === 'disabled' && names.has('disabled'))))
          found.push(`${line} ${name} repeats ${state === 'disabled' ? 'the disabled state' : `aria-${state}`}`)
      }
    }
  }

  return found
}

describe('the contract of every kayjs-ui component', () => {
  it('reads the component templates', () => {
    expect(templates.length).toBeGreaterThan(70)
  })

  it('marks every inner element an app could style with a part', () => {
    expect(templates.flatMap(unmarked)).toEqual([])
  })

  it('carries a state in an ARIA attribute or a named data attribute, never a data-state or a mirror of one', () => {
    expect(templates.flatMap(badStates)).toEqual([])
  })

  it('catches an unmarked element and a data-state', () => {
    const source = 'div(part="root" data-state="open" aria-expanded="true")\n  span {label}\n'
    const template: Template = { file: 'x.kay', source, elements: [...elementsIn(parseKay(source).template)], top: new Set(parseKay(source).template) }

    expect(unmarked(template)).toHaveLength(1)
    expect(badStates(template)).toHaveLength(1)
  })
})
