import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC = join(import.meta.dir, '../src')

const components = readdirSync(SRC).filter(file => file.endsWith('.kay')).map(file => file.slice(0, -4))
const read = (file: string) => readFileSync(join(SRC, `${file}.kay`), 'utf8')
// Whether the props type of a component declares the prop.
const declares = (source: string, name: string) => new RegExp(`^\\s+${name}\\??: `, 'm').test(source)

// Components showing a list, a series or a tree of data: each says what it reads with nothing to show (`emptyLabel`), and lets the app draw that state itself (an `@empty` block).
const DATA = ['bar-chart', 'bar-list', 'scatter-chart', 'line-chart', 'contribution-graph', 'sparkline', 'status-strip', 'media-gallery', 'carousel', 'timeline', 'tree-view', 'description-list', 'virtual-list', 'table', 'combobox', 'multi-select', 'icon-picker', 'command-palette']

// A component whose data arrives late words that state `loadingLabel`, its failure `failureLabel` and the way out `retryLabel`; these have no word for a part, for the reason given.
const FAILURE_EXEMPT: Record<string, readonly string[]> = {
  // Typing again asks again.
  'combobox': ['retryLabel'],
  'multi-select': ['retryLabel'],
  'select': ['retryLabel'],
  // A branch shows a spinner while it loads.
  'tree-view': ['loadingLabel'],
  // A call's failure is worded, with no data to load or ask for again: a button's pending label says the wait, and a failure is not retried by a word.
  'save-form': ['loadingLabel', 'retryLabel'],
  'confirm-delete': ['loadingLabel', 'retryLabel'],
  'form': ['loadingLabel', 'retryLabel'],
  'form-dialog': ['loadingLabel', 'retryLabel'],
  'copy-button': ['loadingLabel', 'retryLabel'],
  'record-button': ['loadingLabel', 'retryLabel'],
  'audio-player': ['loadingLabel', 'retryLabel'],
  'image-cropper': ['loadingLabel', 'retryLabel'],
  // Its search words `searchingLabel`, and typing again asks again.
  'icon-picker': ['loadingLabel', 'retryLabel'],
}

describe('every data component words its empty state the same way', () => {
  for (const file of DATA) {
    it(file, () => {
      const source = read(file)

      expect(declares(source, 'emptyLabel'), `${file} takes no \`emptyLabel\``).toBe(true)
      expect(declares(source, 'empty'), `${file} takes no \`@empty\` block`).toBe(true)
    })
  }
})

describe('a component that words an empty text lets the app draw the state', () => {
  for (const file of components.filter(file => declares(read(file), 'emptyLabel'))) {
    it(file, () => {
      expect(DATA, `${file} is missing from the list of data components`).toContain(file)
      expect(declares(read(file), 'empty'), `${file} takes \`emptyLabel\` but no \`@empty\` block`).toBe(true)
    })
  }
})

describe('a component that can fail words loading, failure and retry the same way', () => {
  const failing = components.filter(file => declares(read(file), 'failureLabel'))

  it('finds the components that can fail', () => {
    expect(failing).toContain('table')
  })

  for (const file of failing) {
    it(file, () => {
      const source = read(file)

      for (const name of ['loadingLabel', 'retryLabel'].filter(name => !FAILURE_EXEMPT[file]?.includes(name)))
        expect(declares(source, name), `${file} takes no \`${name}\``).toBe(true)
    })
  }
})
