import { render } from '@solidjs/web'
import { selection } from 'kay'
import { createEffect, createRoot, flush } from 'solid-js'
import TodoList from './todo-list.kay'

export function mount(element: HTMLElement) {
  return render(() => TodoList({
    todos: [
      { id: 1, title: 'Write the compiler', done: true },
      { id: 2, title: 'Ship it', done: false },
    ],
  }), element)
}

// A hundred rows each tracking `selected.is(row)`, counting how often each one runs.
export function selectionRows(initial?: number) {
  const selected = selection<number>(initial)
  const runs = Array.from<number>({ length: 100 }).fill(0)
  const dispose = createRoot((dispose) => {
    for (const row of runs.keys()) {
      createEffect(() => selected.is(row), () => {
        runs[row] = runs[row]! + 1
      })
    }

    return dispose
  })

  flush()

  return { selected, runs, dispose, flush }
}
