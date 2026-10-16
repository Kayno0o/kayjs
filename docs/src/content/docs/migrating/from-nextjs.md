---
title: Migrating from Next.js
order: 3
description: Map what you know from the Next.js app router to kay, concept by concept, and see what has no counterpart.
---

There is no `kay migrate` command for Next.js, as JSX and hooks do not become `.kay` templates by a mechanical rewrite. You move a project by hand, one route at a time. This page maps each part of the app router to its kay counterpart, and lists what kay does not have.

Start with `kay new` (see [Installation](/getting-started/installation)).

The biggest change is the way components work. In Next.js a component is a server component until it says `'use client'`. In kay a component is HTML until it reacts to the user, and nothing marks the line.

## Files and routes

| Next.js | kay |
| --- | --- |
| `app/about/page.tsx` | `src/routes/about.kay`, or `about/index.kay` |
| `layout.tsx` with `children` | `_layout.kay`, which renders the page at `slot` |
| `not-found.tsx` | `_404.kay` |
| `error.tsx` | `_error.kay`, reading `ctx.error` |
| `loading.tsx` and `Suspense` | An `await` block around a promise left unawaited |
| `route.ts` | An [API route](/guides/api-routes) in `src/api/`, or an [endpoint file](/essentials/routing#endpoint-files) |
| `[slug]` and `[...slug]` | `[slug]` and `[...slug]` |
| `[[...slug]]` | No single file. `[[page]]` is one optional segment and `[...path]` a catch-all, see [Routing](/essentials/routing#dynamic-routes) |
| `(group)` | `(group)`, a folder that adds nothing to the URL |
| `public/` | `public/` |
| `next.config.js` | `kay.config.ts` |
| `redirects()` in the config | `redirects` in `kay.config.ts` |

A fixed name wins over a param, and a param over a catch-all.

## Server components and client components

A server component reads its data where it renders, with `async` and `await`. A kay component renders synchronously. The data comes from the `--- server` fence of the page or layout, and goes down to components as props.

```tsx
// app/todos/page.tsx
import { revalidatePath } from 'next/cache'
import { addTodo, listTodos } from '@/data'

async function add(formData: FormData) {
  'use server'
  await addTodo(String(formData.get('title')))
  revalidatePath('/todos')
}

export default async function Page() {
  const todos = await listTodos()

  return (
    <>
      <ul>{todos.map(todo => <li key={todo.id}>{todo.title}</li>)}</ul>
      <form action={add}>
        <input name="title" />
        <button>Add</button>
      </form>
    </>
  )
}
```

In kay it is one file.

```kay
--- server
import { s } from 'kay'
import { addTodo, listTodos } from '../data'

const newTodo = s.Object({
  title: s.String({ minLength: 1, maxLength: 200, error: 'Write a title' }),
})

export const add = action(newTodo, async ({ title }) => {
  await addTodo(title)
})

const todos = await listTodos()
---
ul
  for todo of todos
    li {todo.title}
form(action={add})
  input(field="title" placeholder="New todo")
  error title
  button Add
```

The fence never reaches the browser, and the page renders again after the action, so there is no `revalidatePath` to call for it.

A client component becomes an island, with no marker. A component is an island when it has an `on*` handler, a `bind:`, a `ref` or a script using `signal` or another value from `kay`.

Everything else ships no JavaScript.

```tsx
'use client'
import { useState } from 'react'

export function Counter() {
  const [count, setCount] = useState(0)

  return <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>
}
```

```kay
---
const count = signal(0)
---
button(onClick={() => count++}) Clicked {count()} times
```

`kay build` lists every island and the first thing that made it one.

As in Next.js, props to an island are serialized, so a page cannot pass one a function. Props can be objects, arrays, strings, numbers, booleans, dates, maps and sets. See [Islands](/essentials/islands).

## Hooks and state

| React | kay |
| --- | --- |
| `useState(0)` | `signal(0)`, read as `count()` and written as `count++` or `count.set(1)` |
| `useMemo(() => ..., [a, b])` | `memo(() => ...)`, which tracks what it reads, so there is no dependency list |
| `useEffect(() => ..., [a])` | `effect(() => ...)`, which runs after the render and again when a signal it read changes |
| `useEffect(() => ..., [])` | `onMount(() => ...)`, in the browser only |
| `useRef` and `ref={...}` | `ref={element => ...}` |
| `useContext` | `context`, see the [islands reference](/llms/islands) |
| `children` | `slot` |
| A prop that is JSX | An `@name` block, rendered with `slot name` |
| `props` | `const { title } = props<{ title: string }>()` |
| `{cond && <p />}` | `if cond` |
| `{items.map(item => <li key={item.id} />)}` | `for item of items`, keyed by `item.id` |
| `className` | The `.name` shorthand or `class` |
| `dangerouslySetInnerHTML` | `innerHTML` through `trustHtml` or `sanitizeHtml` |
| Zustand, Jotai, Redux | A module exporting a signal, shared by every island that imports it |
| A preference kept in a cookie or `localStorage` | `persisted('theme', 'light')`, kept in a cookie the server reads too |

State shared across islands lives in a `.ts` module.

```ts
import { persisted, signal } from 'kay'

export const cart = signal<string[]>([])
export const theme = persisted('theme', 'light')
```

## Data, caching and rendering

| Next.js | kay |
| --- | --- |
| `params` in a page | `ctx.params`, typed from the file name |
| `searchParams` in a page | `ctx.query`, typed by a `query` schema in `page` |
| `cookies()`, `headers()` | `ctx.cookies`, `ctx.headers` |
| `redirect('/login')` | `ctx.redirect('/login')` |
| `notFound()` | `ctx.notFound()` |
| `generateStaticParams` | `prerender: [{ slug: 'a' }]` in `page`, or a content collection |
| `export const revalidate = 3600` | `revalidate: '1h'` in `page` |
| `unstable_cache`, `fetch` with `next.revalidate` | `cached(key, ttl, load)` from `kay/cache` |
| `revalidateTag`, `revalidatePath` | `invalidate(key)`, or `invalidatePage(path => ...)` from `kay/cache` |
| `generateMetadata` and `metadata` | A `head` block, see [Head and SEO](/essentials/head-and-seo) |
| `next/image` | An imported image is its URL, `img(src={photo})`, which kay sizes and serves in modern formats |
| `next/font` | `fonts` in `kay.config.ts`, which self-hosts font files, see [Styling and assets](/essentials/styling-and-assets#fonts) |
| `next/link` | A plain `a(href="/about")`, which `kay check` verifies |
| `useRouter().push('/todos')` | `navigate('/todos')` from `kay` |
| `.env` and `NEXT_PUBLIC_` | `defineEnv` for the server, `publicEnv` in `kay.config.ts` for the browser |
| Streaming with `Suspense` | An `await` block, see [Data loading](/essentials/data-loading) |

`kay build` prerenders a page by itself when it can show that the page reads nothing from its request or the clock. It reports what it decided for each route. See [Routing](/essentials/routing#prerendering).

## Server actions

A server action is an `async` function marked `'use server'`. A kay action is exported from a page, and takes a schema that kay checks the input against.

| Next.js | kay |
| --- | --- |
| `'use server'` function in a form | `export const add = action(schema, handler)` and `form(action={add})` |
| `formData.get('title')` and manual checks | The schema, with `field="title"` checked against it by `kay check` |
| `useActionState` | `add.error('title')`, `add.failed()`, `add.succeeded()` |
| `useFormStatus` | `add.pending()` |
| A returned error object | `return ctx.fail(409, { message })`, read as `add.failed()?.data` |
| Calling the action from a client component | Import it from the page and call it, `await add({ title })` |

A form posts without JavaScript, and an action refuses a post from another site. See [Forms and actions](/essentials/forms-and-actions).

## Middleware

`middleware.ts` runs in front of every request, and a matcher picks the paths. In kay the work splits by what it does. A redirect for signed-out visitors is a guard.

```ts
// middleware.ts
export function middleware(request: NextRequest) {
  if (!request.cookies.has('session'))
    return NextResponse.redirect(new URL('/login', request.url))
}

export const config = { matcher: '/account/:path*' }
```

```ts
// src/routes/account/_guard.ts
import { guard } from 'kay'

export default guard(({ locals, redirect }) => {
  if (locals.user === undefined)
    return redirect('/login')
})
```

| Next.js | kay |
| --- | --- |
| A matcher on a path | The folder a `_guard.ts` sits in. It runs before every page, action and endpoint in it and below |
| Redirecting or rejecting | `return redirect(...)` or `return deny(403, ...)` in a guard |
| Adding a user or a header for the request | An Elysia plugin using `derive`, which puts it on `ctx.locals` |
| A sign-in library such as Auth.js | `session()` and [kayjs-auth](/libraries/kayjs-auth) |

See [Sessions and guards](/guides/sessions-and-guards).

## What has no equivalent

- **React and its libraries.** A `.kay` file is its own template language, so React components do not run in it. Rewrite each one. A plain browser library, such as a chart, runs inside an island.
- **Parallel routes, intercepting routes and `template.tsx`.** kay has none of them.
- **Async components.** A component renders synchronously, so load in the page's server fence.
- **Edge and Node runtimes.** kay runs on Bun alone. `kay build --compile` makes one executable and `kay build --static` makes plain files, see [Deployment](/guides/deployment).
- **A server payload beside the HTML.** kay sends none, so a page costs its HTML plus its islands.

Run `bun run check` as you go. It type-checks every `.kay` file and reports each link to a page that does not exist.
