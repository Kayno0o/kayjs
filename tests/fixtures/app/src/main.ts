import TodoList from './todo-list.kay'

export const view = () => TodoList({ todos: [{ id: 1, title: 'Write the compiler', done: false }] })
