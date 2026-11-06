import { Glob } from 'bun'
import { expect, test } from 'bun:test'

const CALLBACK = /^ {2}(on[A-Z]\w*)\??:/gm
const CHANGE = /^on([A-Z]\w*)Change$/
// Change callbacks that only observe state the component owns, with no prop to hold it, or that hold it as a list (`expanded`) of the things they report one at a time.
const OBSERVE_ONLY = new Set(['audio-player.kay:onChapterChange', 'date-input.kay:onMonthChange', 'date-range-input.kay:onMonthChange', 'hover-card.kay:onOpenChange', 'table.kay:onOpenChange', 'table.kay:onScrollChange', 'tree-view.kay:onOpenChange'])
const SOURCES = [...new Glob('*.kay').scanSync('src')].toSorted()

async function declared() {
  const result = new Map<string, { callbacks: string[], props: Set<string> }>()

  for (const file of SOURCES) {
    const source = await Bun.file(`src/${file}`).text()
    const props = new Set([...source.matchAll(/^ {2}(\w+)\??:/gm)].map(match => match[1]!))

    result.set(file, { callbacks: [...source.matchAll(CALLBACK)].map(match => match[1]!), props })
  }

  return result
}

// The rule of `llms/tables-navigation-and-layout.md`: state a prop can hold reports through `on<Prop>Change`, `onSelect` is the press of an item.
test('every on<Prop>Change callback sits beside the prop it reports', async () => {
  const broken: string[] = []

  for (const [file, { callbacks, props }] of await declared()) {
    for (const name of callbacks) {
      const prop = CHANGE.exec(name)?.[1]

      if (prop === undefined)
        continue

      const lower = prop[0]!.toLowerCase() + prop.slice(1)

      if (!props.has(lower) && !props.has(prop) && !OBSERVE_ONLY.has(`${file}:${name}`))
        broken.push(`${file}: ${name} has no \`${lower}\` prop`)
    }
  }

  expect(broken).toEqual([])
})

test('onSelect is the press of an item: a component with a selected prop reports through onSelectedChange', async () => {
  const broken: string[] = []

  for (const [file, { callbacks, props }] of await declared()) {
    if (callbacks.includes('onSelect') && props.has('selected'))
      broken.push(`${file}: onSelect beside \`selected\` is onSelectedChange`)
  }

  expect(broken).toEqual([])
})

test('onSelectedChange only reports a selected prop', async () => {
  const broken: string[] = []

  for (const [file, { callbacks, props }] of await declared()) {
    if (callbacks.includes('onSelectedChange') && !props.has('selected'))
      broken.push(`${file}: onSelectedChange has no \`selected\` prop`)
  }

  expect(broken).toEqual([])
})
