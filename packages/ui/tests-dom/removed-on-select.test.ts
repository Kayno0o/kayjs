import { expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import Table from '../src/table.kay'
import Timeline from '../src/timeline.kay'
import TreeView from '../src/tree-view.kay'

// Typed loosely, as the props under test are the ones the types refuse.
const mount = mountComponent as (component: unknown, props: unknown) => Promise<unknown>

// The `onSelect` of 1.87 is gone: it fails `kay check`, and a caller the check never saw gets an error, not a DOM listener on the root.
test.each([
  ['Table', Table, { rows: [], columns: [] }],
  ['TreeView', TreeView, { nodes: [], label: 'x' }],
  ['Timeline', Timeline, { entries: [] }],
] as const)('%s throws for an onSelect, naming onSelectedChange', async (name, component, props) => {
  await expect(mount(component, { ...props, onSelect: () => undefined })).rejects.toThrow(`a ${name} has no onSelect since 1.91; use onSelectedChange`)
})

test.each([
  ['Table', Table, { rows: [], columns: [] }],
  ['TreeView', TreeView, { nodes: [], label: 'x' }],
  ['Timeline', Timeline, { entries: [] }],
] as const)('%s takes an onSelect a wrapper forwards as undefined', async (_name, component, props) => {
  const mounted = await mount(component, { ...props, onSelect: undefined }) as { unmount: () => void }

  mounted.unmount()
})
