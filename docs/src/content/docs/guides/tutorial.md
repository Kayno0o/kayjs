---
title: "Tutorial: a reading list"
order: 1
description: Build a small reading list with a page, a typed form action, an island and a page per book.
---

This builds a small reading list: a page listing books from the server, a form adding one through a typed action, an island filtering the list in the browser, and a page per book. The finished app is `examples/reading-list` in kay's repository.

## Create the project

kay is published as `@kaynooo/kayjs` on the registry at git.kaynooo.fr. Tell Bun where the `@kaynooo` scope lives once, in `~/.bunfig.toml`:

```toml
[install.scopes]
"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"
```

Then scaffold a project and start it:

```sh
bunx -p @kaynooo/kayjs kay new reading-list -y
cd reading-list
bun install
bun run dev
```

`-y` takes the default `server` preset; without it, `kay new` asks in the terminal for a preset and then for each feature. `kay dev` serves it on http://localhost:3000 and reloads the page on every change, and Alt+click on any element opens the `.kay` line that wrote it in your editor (see the [inspector](/reference/cli#inspector)). Pages live in `src/routes/`, one `.kay` file per page: `src/routes/index.kay` is `/`.

## Keep the books in a module

The data lives in a plain TypeScript module, in memory here, where a real app would ask its database. Create `src/books.ts`:

```ts
export interface Book {
  id: number
  title: string
  author: string
  read: boolean
}

const books: Book[] = [
  {
    id: 1,
    title: 'The Left Hand of Darkness',
    author: 'Ursula K. Le Guin',
    read: true,
  },
  { id: 2, title: 'Piranesi', author: 'Susanna Clarke', read: false },
]

export async function listBooks(): Promise<Book[]> {
  return books
}

export async function findBook(id: number): Promise<Book | undefined> {
  return books.find(book => book.id === id)
}

export async function addBook(title: string, author: string): Promise<Book> {
  const id = Math.max(0, ...books.map(each => each.id)) + 1
  const book = { id, title, author, read: false }

  books.push(book)

  return book
}
```

## List them on a page

A `.kay` file starts with its fences, then the template. The `--- server` fence runs on the server for every request, and every name it declares reaches the template, typed. Replace `src/routes/index.kay` with:

```kay
--- server
import { listBooks } from '../books'

const books = await listBooks()
---
head
  title Books
h1 Books
ul
  for book of books
    li
      a(href={`/books/${book.id}`}) {book.title}
      |  by {book.author}
```

The template is indented like pug: a line is an element, `tag.class(attributes) text`, and what is indented under it is its content. Every dynamic value sits in `{}`. A `for` renders a row per book, and `|` starts a line of text.

## A page per book

A file name in brackets is a param: `src/routes/books/[id=integer].kay` serves `/books/1`, and the `integer` matcher hands the page a number, refusing `/books/abc`. Create it:

```kay
--- server
import { findBook } from '../../books'

const book = await findBook(ctx.params.id) ?? ctx.notFound()
---
head
  title {book.title}
h1 {book.title}
p by {book.author}
p {book.read ? 'Read' : 'Not read yet'}
a(href="/") Back to the list
```

`ctx.notFound()` stops the render and answers 404. Run `bun run check`: `kay check` type-checks the templates too, so a typo in `book.titel` is reported at its `.kay` line, and so is a link to a page that does not exist, such as `a(href="/book/1")`.

## Add a book with an action

A server fence exports actions: a schema and a handler. The form posts to it without any JavaScript, and `kay check` verifies each field name against the schema. In the server fence of `src/routes/index.kay`, import `addBook` beside `listBooks` and `s` from `kay`, then export the action after `books`:

```kay
--- server
import { s } from 'kay'
import { addBook, listBooks } from '../books'

const books = await listBooks()

export const add = action(s.Object({
  title: s.String({ minLength: 1, maxLength: 200, error: 'Write a title' }),
  author: s.String({ minLength: 1, maxLength: 100, error: 'Write the author' }),
}), async ({ title, author }, ctx) => {
  if ((await listBooks()).some(book => book.title === title))
    return ctx.fail(409, { message: 'Already on the list' })

  return (await addBook(title, author)).id
})
---
```

Then the form, under the list:

```kay
h2 Add one
form(action={add})
  label Title
    input(name="title")
  if add.error('title') as message
    p.error {message}
  label Author
    input(name="author")
  if add.error('author') as message
    p.error {message}
  if add.failed()?.data as data
    p.error {data.message}
  button Add
```

A post the schema refuses comes back to the page with the fields as they were typed, and `add.error('title')` holds the schema's `error` message. `ctx.fail` sends its data back the same way, read with `add.failed()`. Every string field needs a `maxLength`, so what a visitor posts is bounded: `kay check` reports one without it.

## Filter in the browser with an island

Everything so far ships no JavaScript bundle. A component using signals, handlers or `bind:` is an island: it renders on the server, then hydrates in the browser. Create `src/components/book-filter.kay`:

```kay
---
import type { Book } from '../books'
import { memo, signal } from 'kay'

const { books } = props<{ books: Book[] }>()
const query = signal('')
const unreadOnly = signal(false)
const shown = memo(() => books.filter(book =>
  (!unreadOnly() || !book.read)
  && `${book.title} ${book.author}`.toLowerCase()
    .includes(query().trim().toLowerCase()),
))
---
.filters
  input(
    type="search"
    aria-label="Search the books"
    placeholder="Search"
    bind:value={query}
  )
  label
    input(type="checkbox" bind:checked={unreadOnly})
    |  Unread only
ul
  for book of shown()
    li
      a(href={`/books/${book.id}`}) {book.title}
      |  by {book.author}
  else
    li Nothing matches
```

The script fence, a bare `---`, runs where the component renders. `signal` holds a value, `memo` derives one, and `bind:value` keeps the field and the signal in step. A signal is read by calling it, `shown()`, in the template as in the script, while `bind:value={query}` takes the signal itself, to write it. The `else` under the `for` renders when the list is empty.

Use it in the page in place of the list: import it in a `--- script` fence after the server fence, and pass the books as a prop:

```kay
--- server
import { listBooks } from '../books'

const books = await listBooks()
--- script
import BookFilter from '../components/book-filter.kay'
---
head
  title Books
h1 Books
BookFilter(books={books})
```

The props a page passes an island travel to the browser as data, so they must be serializable: `kay check` refuses a function there.

## Check, test and build

```sh
bun run check   # types, templates, links, form fields and accessibility
bun run test    # bun test, pages and actions served in-process by kay/test
bun run build   # the browser bundle, minified, after the same checks
bun run start   # the production server
```

From here, the reference covers each part in depth: [Routing](/essentials/routing), [Forms and actions](/essentials/forms-and-actions), [Islands](/essentials/islands) and [Testing](/guides/testing). `kay new --template app` scaffolds an app with sessions, a sign-in form and a guarded account page, and this site, in `docs/` in kay's repository, is itself built with kay from content collections.
