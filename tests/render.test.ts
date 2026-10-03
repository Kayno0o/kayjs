import type { Todo } from './fixtures/app/src/todo'
import { join } from 'node:path'
import { renderToString } from '@solidjs/web'
import { plugin } from 'bun'
import { describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { staticFor } from '../src/runtime/static'

plugin(kay())

interface TodoListModule {
  default: (props: { todos: Todo[], title?: string }) => unknown
}

// Hydratable markup separates dynamic text with comment markers; the assertions read the text alone.
const MARKERS = /<!--[$/]-->/g

const { default: TodoList } = await import(join(import.meta.dir, 'fixtures/app/src/todo-list.kay')) as TodoListModule

const todos: Todo[] = [
  { id: 1, title: 'Write the compiler', done: true },
  { id: 2, title: 'Ship <it>', done: false },
]

describe('server rendering through the Bun plugin', () => {
  it('renders a .kay tree with props, defaults, loops and child components', () => {
    const html = renderToString(() => TodoList({ todos })).replace(MARKERS, '')

    expect(html).toContain('<h1>Todos</h1>')
    expect(html).toContain('placeholder="Filter"')
    expect(html).toContain('class="todo done"')
    expect(html).toContain('1. Write the compiler')
    expect(html).toContain('2. Ship &lt;it>')
    expect(html).not.toContain('Nothing matches')
  })

  it('renders the for fallback and an overridden default', () => {
    const html = renderToString(() => TodoList({ todos: [], title: 'Empty' })).replace(MARKERS, '')

    expect(html).toContain('<h1>Empty</h1>')
    expect(html).toContain('Nothing matches')
  })
})

describe('staticFor', () => {
  it('renders each row once with the index for loops keyed by position, an accessor otherwise, and the fallback when empty', () => {
    const row = (item: () => string, index: unknown) => typeof index === 'function' ? `${item()}@${(index as () => number)()}()` : `${item()}@${String(index)}`

    expect(staticFor(['a', 'b'], row, true)).toEqual(['a@0', 'b@1'])
    expect(staticFor(['a', 'b'], row, false)).toEqual(['a@0()', 'b@1()'])
    expect(staticFor(null, row, false, () => 'none')).toBe('none')
    expect(staticFor(false, row, false)).toBeNull()
    expect(staticFor([], row, true, () => 'none')).toBe('none')
  })
})
