# Build a site

The pieces of a small site, in the order they are usually written: config, layout, a Markdown collection with its pages, islands and a form. Each section names the topic file covering the rest; open one only for what this page leaves out.

## Config

`kay.config.ts` names the site and wraps every page title:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  lang: 'en',
  seo: {
    name: 'Journal',
    titleTemplate: '%s | Journal',
    description: 'Notes worth keeping',
  },
})
```

A page's `head` holding `title Posts` renders `Posts | Journal`; `title(raw) Journal` is written as it is, for the home page. See [Head and site metadata](head.md).

## Layout

`src/routes/_layout.kay` wraps every page of its directory and below, the 404 page included, rendering the page at its `slot`:

```kay
--- server
const section = ctx.url.pathname.split('/')[1]
---
header
  a(href="/") Journal
  nav(aria-label="Main")
    a(
      href="/posts"
      aria-current={section === 'posts' ? 'page' : undefined}
    )
      | Posts
    a(href="/about") About
main
  slot
footer © Journal
```

A link to the page being rendered gets `aria-current="page"` by itself, as the About link does on `/about`; a section's link lit on the pages below it, `/posts/first` here, is the template's to write, and a link writing `aria-current={undefined}` is never marked, such as a logo linking to `/`. See [Pages and routing](routing.md).

## Content and its pages

Collections are declared in `src/content.config.ts`, each folder relative to that module, so `content/posts` is `src/content/posts`:

```ts
import { s } from 'kay'
import { collection } from 'kay/content'

export const posts = collection('content/posts', {
  schema: s.Object({
    title: s.String(),
    date: s.Date(),
    tags: s.Array(s.String(), { default: [] }),
  }),
})
```

`await posts.all()` lists the entries, each with its `slug`, its `data` read against the schema and its rendered body as `Content`; `await posts.get(slug)` reads one, or `undefined`. A page reads them in its `--- server` fence, `src/routes/posts/[slug].kay` here:

```kay
--- server
import { posts } from '../../content.config'

const post = await posts.get(ctx.params.slug) ?? ctx.notFound()
const { Content } = post
---
head
  title {post.data.title}
h1 {post.data.title}
article
  Content
```

`ctx.notFound()` renders the closest `_404.kay` with status 404; `src/routes/_404.kay` also answers every URL no page serves:

```kay
head
  title Not found
h1 Not found
a(href="/") Back home
```

See [Content collections](content.md).

## Islands

A component whose template handles an event, `onClick`, or binds a field, `bind:value`, or whose script uses a value from `kay`, such as `signal`, runs in the browser as an island; the rest of the page ships no JavaScript. A page hands it server data as props, plain values only, so it maps the entries to what the island shows, `src/routes/posts/index.kay` here:

```kay
--- server
import { posts } from '../../content.config'
import PostFilter from '../../components/post-filter.kay'

const list = (await posts.all()).map(post => ({
  slug: post.slug,
  title: post.data.title,
}))
---
head
  title Posts
h1 Posts
PostFilter(posts={list})
```

```kay
---
const { posts } = props<{ posts: { slug: string, title: string }[] }>()
const query = signal('')
const shown = memo(() =>
  posts.filter(post =>
    post.title.toLowerCase().includes(query().toLowerCase()),
  ),
)
---
input(type="search" aria-label="Filter posts" bind:value={query})
ul
  for post of shown key={post.slug}
    li: a(href={`/posts/${post.slug}`}) {post.title}
```

State several islands share, or one kept across visits, is a signal in a `.ts` module: `export const saved = persisted<string[]>('saved', [], { storage: 'local' })` from `kay` keeps it in localStorage. An island importing it calls it, `saved()`, in the template too. See [Islands and navigation](islands.md).

## Forms

A page's server fence exports an action, a schema and a handler; `form(action={comment})` posts to it without JavaScript, and a refused post renders the page again, the fields holding what was sent and `ctx.failed(comment)` telling why. Each field names itself with `field`, which writes its `name` and the constraints the schema gives it, so the browser checks them without JavaScript, and an `error` line shows the message a refused post gave that field, the field described by it for screen readers; a bare `error` shows the form's own:

```kay
form(action={comment})
  error
  label(for="name") Name
  input#name(field="name")
  error name
  label(for="text") Comment
  textarea#text(field="text")
  error text
  button Send
```

With kay's script, the form posts without a reload, checked first in the browser against the schema, each refused field showing the schema's `error` message in the browser's bubble.

To show the same rules as text next to each field, before posting and after a post the server refused, keep them in a module both sides import, `src/comment.ts` here:

```ts
export interface Comment { name: string, text: string }
export type CommentErrors = Partial<Record<keyof Comment, string>>

export function checkComment({ name, text }: Comment): CommentErrors {
  const errors: CommentErrors = {}

  if (name.trim() === '')
    errors.name = 'Write your name.'

  if (text.trim().length < 10)
    errors.text = 'Write at least 10 characters.'

  return errors
}
```

The handler checks them, `src/routes/guestbook.kay`; `kay check` asks each string field of the schema for a `maxLength` (`unbounded-string`):

```kay
--- server
import { s } from 'kay'
import { checkComment } from '../comment'
import CommentForm from '../components/comment-form.kay'

const newComment = s.Object({
  name: s.String({ maxLength: 100 }),
  text: s.String({ maxLength: 2000 }),
})

export const comment = action(newComment, (input, ctx) => {
  const errors = checkComment(input)

  if (Object.keys(errors).length > 0)
    return ctx.fail(422, { errors })

  return { name: input.name.trim() }
})
---
head
  title Guestbook
h1 Guestbook
CommentForm
```

And an island holding the form checks them before posting. Its `onSubmit` runs before kay's own listener, so `event.preventDefault()` stops kay's post, `novalidate` skips kay's check in the browser, and the island posts the fields itself once they pass:

```kay
---
import { comment } from '../routes/guestbook.kay'
import { checkComment } from '../comment'
import type { CommentErrors } from '../comment'

const errors = signal<CommentErrors>(comment.failed()?.data?.errors ?? {})
const thanked = signal(comment.succeeded()?.data.name ?? '')

async function submit(event: SubmitEvent) {
  event.preventDefault()
  const form = event.currentTarget as HTMLFormElement
  const fields = new FormData(form)
  const found = checkComment({
    name: String(fields.get('name')),
    text: String(fields.get('text')),
  })

  errors.set(found)

  if (Object.keys(found).length === 0) {
    thanked.set((await comment(fields, { refresh: false })).name)
    form.reset()
  }
}
---
if thanked
  p Thanks, {thanked}!
form(action={comment} novalidate onSubmit={submit})
  label(for="name") Name
  input#name(name="name")
  if errors.name
    p.error {errors.name}
  label(for="text") Comment
  textarea#text(name="text")
  if errors.text
    p.error {errors.text}
  button Send
```

Without JavaScript the same form posts as a plain one, and the island's first render reads the refused post's errors, or the success. A call the server refuses throws `ActionError`, whose `data` is what `ctx.fail` received. See [Actions](actions.md).

## Check, build, run

`kay check` reports type errors, template mistakes, links to no page and form fields no schema has, at the `.kay` line; `kay build` builds the site, and the server in `src/server.ts` serves it. See [Project setup and commands](project.md).
