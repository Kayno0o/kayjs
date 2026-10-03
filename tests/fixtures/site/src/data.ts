export interface Todo {
  id: number
  title: string
  done: boolean
}

const seeded: Todo[] = [
  { id: 1, title: 'Write the compiler', done: true },
  { id: 2, title: 'Serve pages', done: false },
]
const todos = structuredClone(seeded)

// Test files share one process, so each one that adds todos puts the seeded ones back for the next.
export function resetTodos(): void {
  todos.splice(0, todos.length, ...structuredClone(seeded))
}

export async function listTodos(): Promise<Todo[]> {
  return todos
}

export async function findTodo(id: number): Promise<Todo | undefined> {
  return todos.find(todo => todo.id === id)
}

export async function addTodo(title: string): Promise<Todo> {
  const todo = { id: todos.length + 1, title, done: false }

  todos.push(todo)

  return todo
}
