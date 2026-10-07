export interface Book {
  id: number
  title: string
  author: string
  read: boolean
}

// Kept in memory, so a restart starts over: a real app keeps them in a database.
const books: Book[] = [
  { id: 1, title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin', read: true },
  { id: 2, title: 'Piranesi', author: 'Susanna Clarke', read: false },
]

export async function listBooks(): Promise<Book[]> {
  return books
}

export async function findBook(id: number): Promise<Book | undefined> {
  return books.find(book => book.id === id)
}

export async function addBook(title: string, author: string): Promise<Book> {
  const book = { id: Math.max(0, ...books.map(each => each.id)) + 1, title, author, read: false }

  books.push(book)

  return book
}
