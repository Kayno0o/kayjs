// `kay new <name> [--template minimal|fullstack] [--force]` project scaffolder.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface ScaffoldOptions {
  template?: 'minimal' | 'fullstack' | undefined
  force?: boolean | undefined
  kayVersion?: string | undefined
}

export function scaffoldProject(targetDir: string, options: ScaffoldOptions = {}): { root: string, files: string[] } {
  const root = resolve(targetDir)
  const name = basename(root).toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'kay-app'
  const template = options.template ?? 'minimal'
  const kayVersion = options.kayVersion ?? '^2.0.0-alpha.0'

  if (existsSync(root) && readdirSync(root).length > 0 && !options.force)
    throw new Error(`kay new: directory "${root}" is not empty (pass --force to overwrite)`)

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
      dependencies: {
        kay: kayVersion,
      },
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
        jsxImportSource: 'kay',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ['bun'],
      },
      include: ['src', 'kay.config.ts'],
    }, null, 2)}\n`,

    'kay.config.ts': `import { defineConfig } from 'kay/server'

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

    'src/routes/_layout.tsx': `import type { KayChild } from 'kay'
import { Head } from 'kay'
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

    'src/components/Counter.tsx': `import { signal } from 'kay'

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
    files['src/routes/api/health.ts'] = `import type { RequestContext } from 'kay/server'

export function GET(ctx: RequestContext) {
  return ctx.json({ ok: true, runtime: 'bun' })
}
`
    files['src/actions/greet.ts'] = `import { action } from 'kay/server'

const nameSchema = {
  '~standard': {
    version: 1 as const,
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
    files['src/components/GreetForm.tsx'] = `import { signal } from 'kay'
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
    <form action={greet.url} method="post" onSubmit={onSubmit} style="margin-top:1.5rem;display:flex;gap:.5rem;align-items:center">
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

  const written: string[] = []
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    written.push(rel)
  }

  return { root, files: written }
}
