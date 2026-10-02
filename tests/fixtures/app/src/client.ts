import { render } from '@solidjs/web'
import TodoList from './todo-list.kay'

export function mount(element: HTMLElement) {
  return render(() => TodoList({
    todos: [
      { id: 1, title: 'Write the compiler', done: true },
      { id: 2, title: 'Ship it', done: false },
    ],
  }), element)
}
