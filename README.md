# Kay v2

**Write standard TypeScript & JSX. Zero `'use client'`, zero `client:load`.**
Static UI compiles to `0 KB` HTML strings; interactive components automatically become `~2.5 KB` fine-grained signal islands. Built natively on Bun with single-binary production deploys and a clean plugin API.

## Quick Example

### Interactive Island (`src/components/Counter.tsx`)
No directives needed—using `signal` or an event handler automatically marks it as an island:

```tsx
import { signal } from 'kay'

export function Counter({ start = 0 }: { start?: number }) {
  const count = signal(start)
  return (
    <button class="counter" onClick={() => count.value++}>
      Clicked {count.value}
    </button>
  )
}
```

### Server Page (`src/routes/index.tsx`) — `0 KB` JS
Async route components run strictly on the server:

```tsx
import { Head } from 'kay'
import { Counter } from '../components/Counter'
import { db } from '../db'

export default async function Home() {
  const posts = await db.posts.list()
  return (
    <>
      <Head><title>Blog</title></Head>
      <h1>Posts</h1>
      <Counter start={0} />
      <ul>
        {posts.map(post => (
          <li key={post.id}><a href={`/posts/${post.slug}`}>{post.title}</a></li>
        ))}
      </ul>
    </>
  )
}
```

### Unified Server Action (`src/actions/posts.ts`)
Accepts any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType, TypeBox). Works both as a zero-JS progressive `<form action={createPost} method="post">` and as a typed island RPC call (`await createPost(data)`), with server code automatically stripped from client bundles:

```ts
import { action } from 'kay/server'
import { z } from 'zod'

export const createPost = action(
  z.object({ title: z.string().min(1) }),
  async (input, ctx) => {
    const post = await db.posts.create(input)
    return { id: post.id }
  },
)
```

### Modular Plugins (`kay.config.ts`)
Core stays tiny (~5.5k LOC). Everything optional plugs in cleanly:

```ts
import { i18n } from '@kayjs/i18n'
import { spa } from '@kayjs/spa'
import { tailwind } from '@kayjs/tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({
  plugins: [
    tailwind({ css: 'src/app.css' }),
    i18n({ locales: ['en', 'fr'], defaultLocale: 'en' }),
    spa(),
  ],
})
```

## Commands

```sh
kay new my-app [--template fullstack]  # Scaffold a new project
kay check                              # Validate routes, compiler rules & types
kay dev                                # Fast rebuild + live reload
kay build                              # Production client + server build
kay build --static                     # Pure static HTML export
kay build --compile ./server           # Single standalone executable
kay start                              # Serve built production app
```
