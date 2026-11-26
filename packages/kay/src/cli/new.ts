// `kay new <name> [--template minimal|fullstack|blog|app] [--force]` project scaffolder.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export type ScaffoldTemplate = 'minimal' | 'fullstack' | 'blog' | 'app'

export interface ScaffoldOptions {
  template?: ScaffoldTemplate | undefined
  force?: boolean | undefined
  kayVersion?: string | undefined
}

export function scaffoldProject(targetDir: string, options: ScaffoldOptions = {}): { root: string, files: string[] } {
  const root = resolve(targetDir)
  const name = basename(root).toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'kay-app'
  const template: ScaffoldTemplate = options.template ?? 'minimal'
  const kayVersion = options.kayVersion ?? '^2.0.0-beta.3'

  if (existsSync(root) && readdirSync(root).length > 0 && !options.force)
    throw new Error(`kay new: directory "${root}" is not empty (pass --force to overwrite)`)

  const deps: Record<string, string> = { '@kayjs/kay': kayVersion }
  if (template === 'blog') {
    deps['@kayjs/content'] = kayVersion
    deps['@kayjs/seo'] = kayVersion
    deps['@kayjs/ui'] = kayVersion
  }
  else if (template === 'app') {
    deps['@kayjs/auth'] = kayVersion
    deps['@kayjs/ui'] = kayVersion
  }

  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({
      name,
      private: true,
      type: 'module',
      scripts: {
        dev: 'kay dev',
        build: 'kay build',
        start: 'kay start',
        check: 'kay check',
      },
      dependencies: deps,
      devDependencies: {
        '@types/bun': 'latest',
        'typescript': '^5.8.0',
      },
    }, null, 2)}\n`,

    'tsconfig.json': `${JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        jsxImportSource: '@kayjs/kay',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ['bun'],
      },
      include: ['src', 'kay.config.ts'],
    }, null, 2)}\n`,

    'kay.config.ts': `import { defineConfig } from '@kayjs/kay/config'

export default defineConfig({
  lang: 'en',
  plugins: [],
})
`,

    'public/robots.txt': `User-agent: *\nAllow: /\n`,

    'src/styles/app.css': `*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, sans-serif;
  line-height: 1.6;
  color: #111827;
  background: #fafafa;
}
main {
  max-width: 44rem;
  margin: 4rem auto;
  padding: 0 1.5rem;
}
button {
  font: inherit;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  border: 1px solid #d1d5db;
  background: #fff;
  cursor: pointer;
}
button:hover { background: #f3f4f6; }
`,

    'src/routes/_layout.tsx': `import type { KayChild } from '@kayjs/kay'
import { Head } from '@kayjs/kay'
import '../styles/app.css'

export default function Layout({ children }: { children: KayChild }) {
  return (
    <>
      <Head>
        <title>${name}</title>
      </Head>
      <main>{children}</main>
    </>
  )
}
`,

    'src/components/Counter.tsx': `import { signal } from '@kayjs/kay'

export function Counter({ initial = 0 }: { initial?: number }) {
  const count = signal(initial)
  return (
    <button type="button" onClick={() => count.value++}>
      Count: {count.value}
    </button>
  )
}
`,

    'src/routes/index.tsx': `import { Counter } from '../components/Counter'

export default async function Home() {
  return (
    <section>
      <h1>Welcome to Kay</h1>
      <p>Zero-directive islands, native TSX, and Bun speed.</p>
      <Counter initial={0} />
    </section>
  )
}
`,
  }

  if (template === 'fullstack') {
    files['src/routes/api/health.ts'] = `import type { RequestContext } from '@kayjs/kay/server'

export function GET(ctx: RequestContext) {
  return ctx.json({ ok: true, runtime: 'bun' })
}
`
    files['src/actions/greet.ts'] = `import type { StandardSchemaV1 } from '@kayjs/kay/server'
import { action } from '@kayjs/kay/server'

const nameSchema: StandardSchemaV1<{ name: string }> = {
  '~standard': {
    version: 1,
    vendor: 'kay',
    validate(raw: unknown) {
      const name = String((raw as { name?: unknown })?.name ?? '').trim()
      if (name.length < 2)
        return { issues: [{ message: 'Enter at least 2 characters', path: ['name'] }] }
      return { value: { name } }
    },
  },
}

export const greet = action(nameSchema, async ({ name }) => {
  return { message: \`Hello, \${name}!\` }
})
`
    files['src/styles/app.css'] += `
.greet-form {
  margin-top: 1.5rem;
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
`
    files['src/components/GreetForm.tsx'] = `import { signal } from '@kayjs/kay'
import { greet } from '../actions/greet'

export function GreetForm() {
  const name = signal('')
  const reply = signal('')

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault()
    const res = await greet({ name: name.value })
    reply.value = res.ok ? res.data.message : res.error
  }

  return (
    <form class="greet-form" action={greet.url} method="post" onSubmit={onSubmit}>
      <input
        name="name"
        placeholder="Your name"
        value={name.value}
        onInput={(e) => { name.value = (e.target as HTMLInputElement).value }}
      />
      <button type="submit">Greet</button>
      {reply.value && <span>{reply.value}</span>}
    </form>
  )
}
`
    files['src/routes/index.tsx'] = `import { Counter } from '../components/Counter'
import { GreetForm } from '../components/GreetForm'

export default async function Home() {
  return (
    <section>
      <h1>Welcome to Kay</h1>
      <p>Zero-directive islands, Standard-Schema actions, and Bun speed.</p>
      <Counter initial={0} />
      <GreetForm />
    </section>
  )
}
`
  }

  else if (template === 'blog') {
    delete files['src/components/Counter.tsx']

    files['src/styles/app.css'] = `body { margin: 0; background: var(--ui-paper); color: var(--ui-ink); font-family: var(--ui-font-body); }
.wrap { max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
.site-header { padding-bottom: 1.25rem; margin-bottom: 2rem; border-bottom: 1px solid var(--ui-line); }
.site-brand { font-family: var(--ui-font-display); font-size: 1.35rem; font-weight: 700; text-decoration: none; color: inherit; }
.site-rss { font-size: 0.9rem; color: var(--ui-muted); }
.page-title { margin: 0; font-family: var(--ui-font-display); }
.post-link { color: inherit; text-decoration: none; }
.post-desc { margin: 0; color: var(--ui-muted); }
.post-title { font-family: var(--ui-font-display); margin-bottom: 0.25rem; }
.post-meta { color: var(--ui-muted); margin-top: 0; }
`

    files['content/posts/welcome.md'] = `---
title: Welcome to ${name}
date: 2026-11-23
description: A zero-JS static Markdown blog built with Kay v2.
tags: [kay, bun]
---
## Fast by Default

This post is rendered at build time using Bun's native Zig Markdown engine and ships **0 KB** of client JavaScript.
`
    files['src/posts.ts'] = `import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineCollection } from '@kayjs/content'

export interface PostMeta {
  title: string
  date: string
  description?: string
  tags?: string[]
  draft?: boolean
}

const postsDir = existsSync(join(import.meta.dir, '../content/posts'))
  ? join(import.meta.dir, '../content/posts')
  : join(import.meta.dir, '../../content/posts')

export const posts = defineCollection<PostMeta>({ dir: postsDir })
`
    files['kay.config.ts'] = `import { content } from '@kayjs/content'
import { seo } from '@kayjs/seo'
import { ui } from '@kayjs/ui/plugin'
import { defineConfig } from '@kayjs/kay/config'
import { posts } from './src/posts'

export default defineConfig({
  lang: 'en',
  plugins: [
    ui({ grammar: 'editorial' }),
    seo({ site: 'https://example.com', titleTemplate: '%s — ${name}' }),
    content({
      feeds: [{
        path: '/rss.xml',
        title: '${name}',
        description: 'Articles & notes',
        site: 'https://example.com',
        linkPrefix: '/blog',
        collection: posts,
      }],
    }),
  ],
})
`
    files['src/routes/_layout.tsx'] = `import type { KayChild } from '@kayjs/kay'
import { Head } from '@kayjs/kay'
import '../styles/app.css'

export default function Layout({ children }: { children: KayChild }) {
  return (
    <>
      <Head>
        <title>${name}</title>
      </Head>
      <div class="wrap">
        <header data-layout="split" class="site-header">
          <a href="/" class="site-brand">${name}</a>
          <a href="/rss.xml" class="site-rss">RSS</a>
        </header>
        <main>{children}</main>
      </div>
    </>
  )
}
`
    files['src/routes/index.tsx'] = `import { Badge, Card, CardBody, CardFooter, CardHeader, Cluster, Stack } from '@kayjs/ui'
import { posts } from '../posts'

export const prerender = true

export default async function BlogIndex() {
  const list = posts.all()
  return (
    <Stack gap="lg">
      <h1 class="page-title">Articles</h1>
      {list.map(post => (
        <Card key={post.slug}>
          <CardHeader>
            <a href={\`/blog/\${post.slug}\`} class="post-link">{post.data.title}</a>
          </CardHeader>
          <CardBody>
            <p class="post-desc">{post.data.description ?? ''}</p>
          </CardBody>
          <CardFooter>
            <Cluster>
              <span>{post.data.date} · {post.readingMinutes} min read</span>
              {(post.data.tags ?? []).map(tag => <Badge key={tag}>{tag}</Badge>)}
            </Cluster>
          </CardFooter>
        </Card>
      ))}
    </Stack>
  )
}
`
    files['src/routes/blog/[slug].tsx'] = `import type { RequestContext } from '@kayjs/kay/server'
import { Button, Stack } from '@kayjs/ui'
import { Head } from '@kayjs/kay'
import { posts } from '../../posts'

export const prerender = true
export function paths() {
  return posts.paths('/blog')
}

export async function load(ctx: RequestContext) {
  const post = posts.get(ctx.params.slug ?? '')
  if (!post)
    return new Response('Not found', { status: 404 })
  return { post }
}

export default function PostPage({ data }: { data: { post: NonNullable<ReturnType<typeof posts.get>> } }) {
  const { post } = data
  return (
    <Stack gap="md">
      <Head><title>{post.data.title}</title></Head>
      <article>
        <h1 class="post-title">{post.data.title}</h1>
        <p class="post-meta">{post.data.date} · {post.readingMinutes} min read</p>
        <div innerHTML={post.html} />
      </article>
      <div><Button href="/" variant="outline">← All posts</Button></div>
    </Stack>
  )
}
`
  }
  else if (template === 'app') {
    delete files['src/components/Counter.tsx']

    files['src/styles/app.css'] = `body { margin: 0; background: var(--ui-paper); color: var(--ui-ink); font-family: var(--ui-font-body); }
.wrap { max-width: 52rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
.site-header { padding-bottom: 1.25rem; margin-bottom: 2rem; border-bottom: 1px solid var(--ui-line); }
.site-brand { font-family: var(--ui-font-display); font-size: 1.3rem; font-weight: 700; text-decoration: none; color: inherit; }
.page-title { margin: 0; font-family: var(--ui-font-display); }
.page-lead { margin: 0; color: var(--ui-muted); }
.m-0 { margin: 0; }
`

    files['src/auth.ts'] = `import { join } from 'node:path'
import { createAuth } from '@kayjs/auth'
import { sqliteAuthStore } from '@kayjs/auth/sqlite'

// Set AUTH_SECRET (at least 32 bytes) in production — see .env.example.
const defaultDb = import.meta.dir.startsWith('/$bunfs')
  ? './data/auth.sqlite'
  : join(import.meta.dir, '../data/auth.sqlite')

export const auth = createAuth({
  store: sqliteAuthStore(process.env.AUTH_DB || defaultDb),
  secret: process.env.AUTH_SECRET || undefined,
  defaultRedirect: '/dashboard',
})
`
    files['.env.example'] = `# Generate a 32+ byte secret for production, e.g.:
#   openssl rand -base64 32
AUTH_SECRET=
AUTH_DB=./data/auth.sqlite
`
    files['kay.config.ts'] = `import { ui } from '@kayjs/ui/plugin'
import { defineConfig } from '@kayjs/kay/config'
import { auth } from './src/auth'

export default defineConfig({
  lang: 'en',
  plugins: [
    ui({ grammar: 'editorial' }),
    auth,
  ],
})
`
    files['src/routes/_layout.tsx'] = `import type { LayoutProps } from '@kayjs/kay'
import { Button, Cluster, Toaster } from '@kayjs/ui'
import { Head } from '@kayjs/kay'
import '../styles/app.css'

export default function Layout({ children, locals }: LayoutProps) {
  const user = locals.user
  return (
    <>
      <Head>
        <title>${name}</title>
      </Head>
      <div class="wrap">
        <header data-layout="split" class="site-header">
          <a href="/" class="site-brand">${name}</a>
          {user
            ? (
                <Cluster>
                  <Button href="/dashboard" variant="ghost" size="sm">{user.email}</Button>
                  <form action="/auth/signout" method="post">
                    <Button type="submit" variant="outline" size="sm">Sign out</Button>
                  </form>
                </Cluster>
              )
            : <Button href="/login" variant="outline" size="sm">Sign in</Button>}
        </header>
        <main>{children}</main>
      </div>
      <Toaster />
    </>
  )
}
`
    files['src/routes/index.tsx'] = `import { Badge, Button, Cluster, Stack } from '@kayjs/ui'

export default async function Home() {
  return (
    <Stack gap="md">
      <Cluster><Badge tone="accent">Kay v2</Badge><Badge>SQLite Auth</Badge></Cluster>
      <h1 class="page-title">Welcome to ${name}</h1>
      <p class="page-lead">Zero-dependency Argon2id auth, @kayjs/ui pure CSS grammar, and Bun speed.</p>
      <Cluster>
        <Button href="/login" tone="accent">Get started</Button>
        <Button href="/dashboard" variant="outline">Dashboard</Button>
      </Cluster>
    </Stack>
  )
}
`
    files['src/routes/login.tsx'] = `import { Button, Card, CardBody, CardHeader, Field, Grid, Stack } from '@kayjs/ui'

export default function LoginPage() {
  return (
    <Grid min="md" gap="lg">
      <Card>
        <CardHeader>Sign in</CardHeader>
        <CardBody>
          <form action="/auth/signin" method="post">
            <Stack gap="sm">
              <input type="hidden" name="redirect" value="/dashboard" />
              <Field id="in-email" label="Email" required><input id="in-email" name="email" type="email" required /></Field>
              <Field id="in-pass" label="Password" required><input id="in-pass" name="password" type="password" required /></Field>
              <Button type="submit" tone="accent">Sign in</Button>
            </Stack>
          </form>
        </CardBody>
      </Card>
      <Card>
        <CardHeader>Create account</CardHeader>
        <CardBody>
          <form action="/auth/signup" method="post">
            <Stack gap="sm">
              <input type="hidden" name="redirect" value="/dashboard" />
              <Field id="up-email" label="Email" required><input id="up-email" name="email" type="email" required /></Field>
              <Field id="up-pass" label="Password" hint="Min 12 characters" required><input id="up-pass" name="password" type="password" minlength="12" required /></Field>
              <Button type="submit" tone="accent">Create account</Button>
            </Stack>
          </form>
        </CardBody>
      </Card>
    </Grid>
  )
}
`
    files['src/routes/dashboard/_middleware.ts'] = `import { auth } from '../../auth'

export default auth.guard({ redirectTo: '/login' })
`
    files['src/routes/dashboard/index.tsx'] = `import type { PageProps } from '@kayjs/kay'
import { Card, CardBody, CardHeader } from '@kayjs/ui'

export default async function DashboardPage({ locals }: PageProps) {
  return (
    <Card>
      <CardHeader>Dashboard</CardHeader>
      <CardBody>
        <p class="m-0">Signed in as <strong>{locals.user?.email}</strong>.</p>
      </CardBody>
    </Card>
  )
}
`
  }

  const written: string[] = []
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    written.push(rel)
  }

  return { root, files: written }
}
