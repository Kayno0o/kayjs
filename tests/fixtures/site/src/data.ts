export interface Todo {
  id: number
  title: string
  done: boolean
}

const todos: Todo[] = [
  { id: 1, title: 'Write the compiler', done: true },
  { id: 2, title: 'Serve pages', done: false },
]

export async function listTodos(): Promise<Todo[]> {
  return todos
}

export async function findTodo(id: number): Promise<Todo | undefined> {
  return todos.find(todo => todo.id === id)
}
