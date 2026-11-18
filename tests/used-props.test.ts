import type { ElementNode } from '../src/compiler/ast'
import { expect, it } from 'bun:test'
import { usedProps } from '../src/compiler/items'

const SOURCE = 'bind:selected show'
const span = (start: number, end: number) => ({ start, end })
const element = (attributes: ElementNode['attributes']) => ({ attributes, children: [] }) as unknown as ElementNode
const text = (name: { start: number, end: number }) => SOURCE.slice(name.start, name.end)

it('names a bound prop as the prop itself, and no prop for a use with a spread', () => {
  expect(usedProps(element([{ kind: 'boolean', name: span(0, 13) }, { kind: 'boolean', name: span(14, 18) }]), text)).toBe(', { "selected": 0, "show": 0 }')
  expect(usedProps(element([{ kind: 'spread', expression: span(0, 1) }]), text)).toBe('')
})
