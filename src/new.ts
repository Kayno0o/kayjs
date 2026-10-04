import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'

// The kay this command runs from: a git checkout, which a new project depends on a packed copy of, or the published package.
const KAY_ROOT = resolve(import.meta.dir, '..')
const INVALID_NAME_CHARS = /[^a-z0-9._~-]+/g
const NAME_EDGES = /^[-._~]+|[-._~]+$/g
const REGISTRY = 'https://git.kaynooo.fr/api/packages/kaynooo/npm/'

// Written as strings rather than template files, which the repository's own `.kay` scans would pick up.
const FILES: Record<string, string> = {
  '.gitignore': 'node_modules\n.kay\n',
  // kay is published to this registry as `@kaynooo/kay`, installed under the name `kay` its imports use.
  '.npmrc': `@kaynooo:registry=${REGISTRY}\n`,
  // Lets test files import pages and their actions.
  'bunfig.toml': '[test]\npreload = ["kay/test/preload"]\n',
  'tests/home.test.ts': `import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite()

it('greets from the server', async () => {
  const home = await site.visit('/')

  expect(home.status).toBe(200)
  expect(home.html).toContain('Hello from the server')
})
`,
  'kay.config.ts': `import { defineConfig } from 'kay/server'

export default defineConfig({ lang: 'en' })
`,
  'src/server.ts': `import process from 'node:process'
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

const app = new Elysia().use(await pages()).listen(Number(process.env.PORT ?? 3000))

console.log(\`Listening on http://localhost:\${app.server?.port}\`)

// Links and redirects in pages are checked against the routes the app serves besides them too.
declare module 'kay' {
  interface Register {
    app: typeof app
  }
}
`,
  'src/app.css': `@view-transition {
  navigation: auto;
}

body {
  margin: 0;
  font-family: system-ui, sans-serif;
}

main {
  max-width: 40rem;
  margin: 2rem auto;
  padding: 0 1rem;
}
`,
  'src/routes/_layout.kay': `---
import '../app.css'
---
head
  title __NAME__
main
  slot
`,
  'src/routes/index.kay': `--- server
const greeting = 'Hello from the server'
---
---
import Counter from '../components/counter.kay'
---
h1 {greeting}
Counter(start={0})
`,
  'src/routes/_404.kay': `h1 Nothing here
a(href="/") Back home
`,
  'src/components/counter.kay': `---
import { signal } from 'kay'

const { start } = props<{ start: number }>()
const count = signal(start)
---
button(onClick={() => count.set(c => c + 1)}) Clicked {count()} times
`,
}

// A site with no server: `kay build --static` writes it to `dist`, which a Forgejo Pages workflow publishes, or a container serves with nginx.
const SITE_FILES: Record<string, string> = {
  'kay.config.ts': `import process from 'node:process'
import { defineConfig } from 'kay/server'

// The Pages workflow sets both: the host the site is published on, and the path it is published under.
export default defineConfig({
  lang: 'en',
  site: process.env.SITE_URL,
  base: process.env.SITE_BASE,
})
`,
  '.forgejo/workflows/pages.yml': `name: Publish to Pages

on:
  push:
    branches:
      - main

permissions:
  contents: write

jobs:
  publish:
    runs-on: debian
    steps:
      - name: Install unzip and git
        run: apt-get update && apt-get install -y unzip git

      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build the site
        env:
          # The host your Forgejo instance publishes Pages on.
          SITE_URL: https://pages.kaynooo.fr
          SITE_BASE: /\${{ github.repository }}
        run: bun run build

      - name: Publish to the gitea-pages branch
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: \${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
          publish_branch: gitea-pages
          force_orphan: true
`,
  // The container option: the same files, served by nginx with the compressed copies the build wrote.
  'Dockerfile': `FROM oven/bun:1 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
`,
  'nginx.conf': `server {
  listen 80;
  root /usr/share/nginx/html;
  gzip_static on;
  gzip_vary on;

  location /_kay/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  location / {
    try_files $uri $uri.html $uri/index.html =404;
  }

  error_page 404 /404.html;
}
`,
  '.dockerignore': 'node_modules\n.kay\ndist\n',
  '.gitignore': 'node_modules\n.kay\ndist\n',
}

export type Template = 'server' | 'site'

export const TEMPLATES: readonly Template[] = ['server', 'site']

export interface NewOptions {
  // The \`kay\` dependency: by default the published kay running this command, or a packed copy of the checkout running it.
  kay?: string
  // `server` by default, an Elysia app serving the pages; `site`, a static site built to files.
  template?: Template
}

// Scaffolds a project that \`kay dev\` runs and \`kay check\` passes as it is; refuses a directory that already holds files.
export async function createProject(target: string, options: NewOptions = {}): Promise<string[]> {
  const dir = resolve(target)

  if (existsSync(dir) && !statSync(dir).isDirectory())
    throw new Error(`kay: ${target} is not a directory`)

  if (existsSync(dir) && (await readdir(dir)).length > 0)
    throw new Error(`kay: ${target} is not empty`)

  const name = packageName(basename(dir))
  const kay = await Bun.file(join(KAY_ROOT, 'package.json')).json() as { name: string, version: string, dependencies: Record<string, string>, devDependencies: Record<string, string> }
  const dependency = options.kay ?? (existsSync(join(KAY_ROOT, '.git')) ? await packKay(join(dir, 'vendor')) : `npm:${kay.name}@^${kay.version}`)
  const site = options.template === 'site'
  const files: Record<string, string> = {
    ...FILES,
    ...site && SITE_FILES,
    'package.json': `${JSON.stringify({
      name,
      type: 'module',
      private: true,
      scripts: site ? { dev: 'kay dev', build: 'kay build --static', check: 'kay check', fmt: 'kay fmt', test: 'bun test' } : { dev: 'kay dev', build: 'kay build', start: 'NODE_ENV=production bun src/server.ts', check: 'kay check', fmt: 'kay fmt', test: 'bun test' },
      dependencies: { elysia: kay.dependencies.elysia, kay: dependency },
      devDependencies: { '@types/bun': kay.devDependencies['@types/bun'] },
    }, null, 2)}\n`,
    'tsconfig.json': `${JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        lib: ['ESNext', 'DOM', 'DOM.Iterable'],
        jsx: 'preserve',
        jsxImportSource: 'kay',
        module: 'Preserve',
        moduleResolution: 'bundler',
        rootDirs: ['.', '.kay/types'],
        types: ['bun'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['src', 'tests', 'kay.config.ts', '.kay/types'],
    }, null, 2)}\n`,
  }

  // A static site has no server of its own.
  if (site)
    delete files['src/server.ts']

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(dir, path), content.replaceAll('__NAME__', name))))

  return Object.keys(files).sort()
}

// What a directory name becomes as a package name, which is also safe to write into a template: lower case letters, digits and `-._~`.
function packageName(directory: string): string {
  return directory.toLowerCase().replace(INVALID_NAME_CHARS, '-').replace(NAME_EDGES, '') || 'app'
}

// A packed copy installs like a published package, its dependencies only; a `file:` folder would drag in its devDependencies too.
async function packKay(vendor: string): Promise<string> {
  const child = Bun.spawn([process.execPath, 'pm', 'pack', '--quiet', '--destination', vendor], { cwd: KAY_ROOT, stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    throw new Error(`kay: packing ${KAY_ROOT} failed\n${errors}`)

  return `file:./vendor/${basename(output.trim())}`
}
