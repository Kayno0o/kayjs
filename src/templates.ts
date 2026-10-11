// The files `kay new` writes, `__NAME__` standing for the package name. Written as strings rather than template files, which the repository's own `.kay` scans would pick up.

export type Feature = 'server' | 'starter' | 'tailwind' | 'accents' | 'eslint' | 'tests' | 'ci' | 'docker' | 'auth' | 'ws'

// What kay.config.ts sets beyond the features, for a project migrated from a site that already had them.
export interface ConfigSettings {
  lang?: string | undefined
  site?: string | undefined
  base?: string | undefined
  // The `seo` defaults, left out where the pages already write their own titles and descriptions.
  seo?: boolean | undefined
}

// The features a project is scaffolded with, as the files ask for them.
interface Setup {
  has: (feature: Feature) => boolean
  // A Tailwind class list, left out of the markup of a project without Tailwind.
  tw: (classes: string) => string
  settings: ConfigSettings
}

const REGISTRY = 'https://git.kaynooo.fr/api/packages/kaynooo/npm/'

// A file of these lines, each `false` left out.
function lines(...entries: (string | false)[]): string {
  return `${entries.filter(entry => entry !== false).join('\n')}\n`
}

// A single-quoted string literal holding this text.
function quote(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

// A file of these blocks, each `false` left out, a blank line between the others.
function blocks(...entries: (string | false)[]): string {
  return `${entries.filter(entry => entry !== false).join('\n\n')}\n`
}

// A `.kay` fence holding these lines, or nothing when none is left.
function fence(opening: string, ...entries: (string | false)[]): string | false {
  const body = entries.filter(entry => entry !== false)

  return body.length > 0 && [opening, ...body, '---'].join('\n')
}

const VIEW_TRANSITION = `@media (prefers-reduced-motion: no-preference) {
  @view-transition {
    navigation: auto;
  }
}`

// astro-template's look: Tailwind over the Catppuccin Mocha palette, the accent one of its colours, which the picker in the header changes.
function tailwindCss({ has }: Setup): string {
  return blocks(
    '@import \'tailwindcss\';',
    VIEW_TRANSITION,
    has('accents') && `/* Static: the picker reads every accent through var(), which Tailwind cannot see. */
@theme static {
  --accent-rosewater: #f5e0dc;
  --accent-flamingo: #f2cdcd;
  --accent-pink: #f5c2e7;
  --accent-mauve: #cba6f7;
  --accent-red: #f38ba8;
  --accent-maroon: #eba0ac;
  --accent-peach: #fab387;
  --accent-yellow: #f9e2af;
  --accent-green: #a6e3a1;
  --accent-teal: #94e2d5;
  --accent-sky: #89dceb;
  --accent-sapphire: #74c7ec;
  --accent-blue: #89b4fa;
  --accent-lavender: #b4befe;
}`,
    `@theme {
  --color-text: #cdd6f4;
  --color-subtext1: #bac2de;
  --color-subtext0: #a6adc8;
  --color-overlay2: #9399b2;
  --color-overlay1: #7f849c;
  --color-overlay0: #6c7086;
  --color-surface2: #585b70;
  --color-surface1: #45475a;
  --color-surface0: #313244;
  --color-base: #1e1e2e;
  --color-mantle: #181825;
  --color-crust: #11111b;
  --color-error: #f38ba8;
${has('accents') ? '\n  /* The accent picker sets --accent on the page. */\n  --color-accent: var(--accent, var(--accent-peach));' : '  --color-accent: #fab387;'}
}`,
    `@layer base {
  body {
    @apply flex min-h-screen flex-col bg-base font-sans text-text;
  }

  a {
    @apply underline decoration-accent underline-offset-4 hover:decoration-2;
  }

  button {
    @apply cursor-pointer rounded border-2 border-overlay0 bg-surface0 px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-base focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:opacity-50;
  }

  input {
    @apply rounded border-2 border-overlay0 bg-surface0 px-2 py-1 text-text focus:border-accent focus:outline-none;
  }

  label {
    @apply text-sm font-medium text-subtext1;
  }

  ::selection {
    @apply bg-overlay2/25;
  }
}`,
    has('starter') && `@layer components {
  .skip-link {
    @apply absolute top-0 left-0 z-100 -translate-y-full bg-base px-2 py-1 text-accent transition-transform focus:translate-y-0;
  }
}`,
  )
}

// Without Tailwind, the skip link stays out of sight until it takes the focus.
const PLAIN_CSS = blocks(VIEW_TRANSITION, `.skip-link {
  position: absolute;
  top: 0;
  left: 0;
  transform: translateY(-100%);
}

.skip-link:focus {
  transform: none;
}`)

const ACCENT_FILES: Record<string, string> = {
  'src/theme.ts': `import { persisted } from 'kay'

export const ACCENTS = ['rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon', 'peach', 'yellow', 'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender'] as const

export type Accent = (typeof ACCENTS)[number]

// Kept in a cookie the server reads, so a page it renders shows the chosen accent from the first paint.
export const accent = persisted<Accent>('accent', 'peach')

// A cookie's value is not checked against the type, so anything but a known accent reads as the default.
export function currentAccent(): Accent {
  const value = accent()

  return ACCENTS.includes(value) ? value : 'peach'
}
`,
  'src/components/accent-picker.kay': `---
import Check from '~icons/tabler/check'
import Palette from '~icons/tabler/palette'
import { accent, ACCENTS, currentAccent } from '../theme'
---
style {\`:root { --accent: var(--accent-\${currentAccent()}); }\`}
details.relative
  summary.flex.cursor-pointer.list-none.items-center.gap-2.text-sm.text-subtext1
    Palette.size-5.text-accent
    | Accent
  div.absolute.right-0.mt-2.grid.grid-cols-7.gap-1.rounded.border-2.border-overlay0.bg-mantle.p-2.shadow-lg(role="radiogroup" aria-label="Accent colour")
    for name of ACCENTS
      button.grid.size-6.place-items-center.rounded.border-2.border-overlay0.p-0(type="button" role="radio" aria-label={name} aria-checked={currentAccent() === name ? 'true' : 'false'} style={\`background-color: var(--accent-\${name})\`} onClick={() => accent.set(name)})
        if currentAccent() === name
          Check.size-4.text-base
`,
}

function header({ has, tw }: Setup): string {
  const links = has('auth') ? '[{ href: \'/\', label: \'Home\' }, { href: \'/account\', label: \'Account\' }]' : '[{ href: \'/\', label: \'Home\' }]'

  return lines(
    '---',
    has('accents') && 'import AccentPicker from \'./accent-picker.kay\'\n',
    `const links = ${links}`,
    '---',
    `header${tw('.border-b-2.border-overlay0.bg-base.px-8.py-3')}`,
    `  nav${tw('.mx-auto.flex.max-w-5xl.items-center.justify-between.gap-4')}(aria-label="Main navigation")`,
    `    a${tw('.text-xl.font-bold.no-underline')}(href="/") __NAME__`,
    `    ul${tw('.flex.gap-4')}`,
    '      for link of links',
    '        li',
    '          a(href={link.href}) {link.label}',
    has('accents') && '    AccentPicker',
  )
}

function layout({ has, tw }: Setup): string {
  return lines(
    fence('---', has('starter') && 'import Header from \'../components/header.kay\'', (has('starter') || has('tailwind')) && 'import \'../app.css\''),
    has('starter') && 'a.skip-link(href="#main-content") Skip to main content\nHeader',
    `main${has('starter') ? '#main-content' : ''}${tw('.mx-auto.w-full.max-w-5xl.grow.px-8.py-6')}`,
    '  slot',
  )
}

function home({ has, tw }: Setup): string {
  if (!has('starter')) {
    return lines(
      fence('---', has('ws') && 'import Online from \'../components/online.kay\''),
      'head',
      '  title Home',
      `h1${tw('.text-3xl.font-bold')} __NAME__`,
      has('auth') && 'a(href="/account") Account',
      has('ws') && 'Online',
    )
  }

  return lines(
    '--- server',
    'const greeting = \'Hello from the server\'',
    '--- script',
    'import Rocket from \'~icons/tabler/rocket\'',
    'import Counter from \'../components/counter.kay\'',
    has('ws') && 'import Online from \'../components/online.kay\'',
    '---',
    'head',
    '  title Home',
    `section${tw('.flex.flex-col.items-center.gap-6.py-12')}`,
    `  Rocket${tw('.size-16.text-accent.motion-safe:animate-bounce')}`,
    `  h1${tw('.text-3xl.font-bold')} {greeting}`,
    '  Counter(start={0})',
    has('ws') && '  Online',
  )
}

function starterFiles(setup: Setup): Record<string, string> {
  return {
    'src/components/header.kay': header(setup),
    'src/components/counter.kay': `---
const { start } = props<{ start: number }>()
const count = signal(start)
---
button(onClick={() => count.set(count + 1)}) Clicked {count} times
`,
    'src/routes/_404.kay': lines('head', '  title Nothing here', `h1${setup.tw('.text-2xl.font-bold')} Nothing here`, 'a(href="/") Back home'),
  }
}

function homeTest({ has }: Setup): string {
  return `import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite()

it('${has('starter') ? 'greets from the server' : 'renders the home page'}', async () => {
  const home = await site.visit('/')

  expect(home.status).toBe(200)
  expect(home.html).toContain('${has('starter') ? 'Hello from the server' : '__NAME__</h1>'}')
})
`
}

function config({ has, settings }: Setup): string {
  const server = has('server')
  const base = settings.base === undefined ? undefined : quote(settings.base)

  return lines(
    !server && 'import process from \'node:process\'',
    has('tailwind') && 'import tailwind from \'bun-plugin-tailwind\'',
    'import { defineConfig } from \'kay/server\'',
    '',
    !server && '// Set when building, as the Pages workflow does: the path the site is published under; kay reads the host it is published on from SITE_URL.',
    'export default defineConfig({',
    `  lang: ${quote(settings.lang ?? 'en')},`,
    settings.site !== undefined && `  site: ${quote(settings.site)},`,
    server ? base !== undefined && `  base: ${base},` : `  base: process.env.SITE_BASE${base === undefined ? '' : ` ?? ${base}`},`,
    has('tailwind') && '  plugins: [tailwind],',
    settings.seo !== false && '  seo: { name: \'__NAME__\', titleTemplate: \'%s | __NAME__\', description: \'__NAME__, made with kay\' },',
    '})',
  )
}

const SERVER_ENTRY = `import process from 'node:process'
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

// Exported for \`kay check\`, which checks links against the routes it serves besides the pages and types \`ctx.locals\` from its plugins.
export const app = new Elysia().use(await pages()).listen(Number(process.env.PORT ?? 3000))
`

const WORKFLOW_SETUP = `      - name: Install unzip and git
        run: apt-get update && apt-get install -y unzip git

      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile`

// Every push is checked and tested before anything deploys it; the container build checks again, as `kay build` does. An app's tests copy a database per test file on a Postgres service.
function testWorkflow({ has }: Setup): string {
  const database = has('auth') && has('tests')

  return blocks(
    `name: ${has('tests') ? 'Tests' : 'Checks'}

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: debian${database
      ? `
    services:
      postgres:
        image: postgres:18-alpine
        env:
          POSTGRES_USER: app
          POSTGRES_PASSWORD: app
          POSTGRES_DB: app_test
        options: --health-cmd "pg_isready -h 127.0.0.1 -U app" --health-interval 2s --health-retries 15`
      : ''}
    steps:
${WORKFLOW_SETUP}`,
    `      # Each problem shows on the diff.
      - name: Check
        run: bun run check --format github`,
    has('eslint') && `      # After the check, which writes the types the lint of .kay files reads.
      - name: Lint
        run: bun run lint`,
    has('tests') && `      - name: Test
        run: bun run test${database
          ? `
        env:
          DATABASE_URL: postgres://app:app@postgres:5432/app_test`
          : ''}`,
  )
}

// A site with no server: `kay build --static` writes it to `dist`, which this workflow publishes to Forgejo Pages.
function pagesWorkflow({ has }: Setup): string {
  return blocks(
    `name: Publish to Pages

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
${WORKFLOW_SETUP}`,
    has('tests') && `      # A failing test publishes nothing; the build checks the project itself.
      - name: Test
        run: bun run test`,
    `${has('tests') ? '' : '      # The build checks the project itself.\n'}      - name: Build the site
        env:
          # The host your Forgejo instance publishes Pages on: replace it with yours.
          SITE_URL: https://pages.example.com
          SITE_BASE: /\${{ github.repository }}
        run: bun run build`,
    has('eslint') && `      # After the build's check, which writes the types the lint of .kay files reads.
      - name: Lint
        run: bun run lint`,
    `      - name: Publish to the gitea-pages branch
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: \${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
          publish_branch: gitea-pages
          force_orphan: true`,
  )
}

// An app's database, and a one-shot service applying the migrations before the app starts.
const APP_COMPOSE = `services:
  db:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      # Letters and digits only: it goes into DATABASE_URL below as it is.
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: app
    volumes:
      - db:/var/lib/postgresql
    healthcheck:
      test: [CMD-SHELL, pg_isready -h 127.0.0.1 -U app]
      interval: 5s
      retries: 10

  # Applies the pending migrations before the app starts, from the build stage, which holds them and the pg-orm command.
  migrate:
    build:
      context: .
      target: build
    command: [bun, run, db:migrate]
    environment:
      DATABASE_URL: postgres://app:\${POSTGRES_PASSWORD}@db:5432/app
    depends_on:
      db:
        condition: service_healthy

  app:
    build: .
    restart: unless-stopped
    ports:
      - 3000:3000
    environment:
      # At least 32 characters, kept out of the repository.
      SESSION_SECRET: \${SESSION_SECRET:?set SESSION_SECRET}
      DATABASE_URL: postgres://app:\${POSTGRES_PASSWORD}@db:5432/app
    depends_on:
      migrate:
        condition: service_completed_successfully

volumes:
  db:
`

// The binary `kay build --compile` makes carries the pages, their assets and the browser build, so the image holds it alone.
function serverContainerFiles({ has }: Setup): Record<string, string> {
  return {
    'Dockerfile': `FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* .npmrc ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run compile

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/server ./server
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER nobody
HEALTHCHECK --interval=30s --timeout=6s CMD ["./server", "--health"]
CMD ["./server"]
`,
    '.dockerignore': 'node_modules\n.kay\nserver\n.env\n',
    'compose.prod.yaml': has('auth')
      ? APP_COMPOSE
      : `services:
  app:
    build: .
    restart: unless-stopped
    ports:
      - 3000:3000
`,
  }
}

// The static site's container: the same files, served by nginx with the compressed copies the build wrote, and the starter's 404 page for a path it lacks.
function staticContainerFiles({ has }: Setup): Record<string, string> {
  return {
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
  }${has('starter') ? '\n\n  error_page 404 /404.html;' : ''}
}
`,
    '.dockerignore': 'node_modules\n.kay\ndist\n',
  }
}

// Sessions, a sign-in, members kept in Postgres through pg-orm and a guarded section.
function authFiles({ tw }: Setup): Record<string, string> {
  return {
    // What production sets, for compose.prod.yaml; development's own settings are in the .env `kay new` wrote.
    '.env.example': 'SESSION_SECRET=at-least-32-characters-kept-out-of-the-repository\nPOSTGRES_PASSWORD=letters-and-digits-only-as-it-goes-into-a-url\n',
    'src/env.ts': `import { s } from 'kay'
import { defineEnv } from 'kay/server'

// Read once as the server boots; \`kay new\` wrote a secret and the development database to .env, and production sets its own.
export const env = defineEnv(s.Object({
  SESSION_SECRET: s.String({ minLength: 32 }),
  DATABASE_URL: s.String(),
  PORT: s.Integer({ default: 3000 }),
}))
`,
    'src/db/member.ts': `import type { InferEntity } from '@kaynooo/pg-orm'
import { defineTable } from '@kaynooo/pg-orm'

// Who signed in, and since when. A change here goes to the database as a migration: \`bun run db:generate\`, then \`bun run db:migrate\`.
export const Member = defineTable('member', f => ({
  id: f.serial().primaryKey(),
  name: f.varchar(40).unique(),
  joined_at: f.timestamptz().defaultRaw('now()'),
}))

export type MemberInterface = InferEntity<typeof Member>
`,
    'src/db/index.ts': `import { Database } from '@kaynooo/pg-orm'
import { env } from '../env'
import { Member } from './member'

export const tables = [Member]

// Connects on the first query; in a test, to the copy \`tests/database.ts\` made for the file.
export const db = new Database({ url: env.DATABASE_URL, tables })
`,
    'pg-orm.config.ts': `import process from 'node:process'
import { Database, defineConfig } from '@kaynooo/pg-orm'
import { Member } from './src/db/member'

// For the \`pg-orm\` command: \`bun run db:generate\` writes a migration from what the tables declare, \`bun run db:migrate\` applies the pending ones.
export default defineConfig({
  db: new Database({ url: process.env.DATABASE_URL, tables: [Member] }),
  migrationsDir: 'migrations',
})
`,
    'migrations/0001_member.sql': `-- migrate:up
CREATE TABLE "member" (
  "id" serial,
  "name" varchar(40) NOT NULL,
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  UNIQUE ("name")
);

-- migrate:down
DROP TABLE IF EXISTS "member";
`,
    'compose.dev.yaml': `# The database for development and tests: \`docker compose up -d --wait\`, which .env points at this file. Tests copy a database per test file on it.
services:
  db:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports:
      - 127.0.0.1:5433:5432
    volumes:
      - db:/var/lib/postgresql
    # What --wait waits for, so the migrations run on a database that answers, over TCP: on its first start the image's server listens on its socket only.
    healthcheck:
      test: [CMD-SHELL, pg_isready -h 127.0.0.1 -U app]
      interval: 2s
      retries: 15

volumes:
  db:
`,
    'src/session.ts': `import { session } from 'kay/server'
import { env } from './env'

// The data travels sealed in the cookie; pass a \`store\`, such as \`sqliteStore('sessions.sqlite')\`, to keep it on the server.
export const sessions = session<{ name: string }>({ secret: env.SESSION_SECRET })
`,
    'src/server.ts': `import { Elysia } from 'elysia'
import { pages } from 'kay/server'
import { env } from './env'
import { sessions } from './session'

// Exported for \`kay check\`, which checks links against the routes it serves besides the pages and types \`ctx.locals\` from its plugins.
export const app = new Elysia().use(sessions).use(await pages()).listen(env.PORT)
`,
    'src/routes/login.kay': `--- server
import { s } from 'kay'
import { db } from '../db'
import { Member } from '../db/member'

// Anyone may sign in under any name, which makes them a member the first time: swap in real credentials, such as @kaynooo/kayjs-auth's.
export const signIn = action(s.Object({ name: s.String({ pattern: '\\\\S', maxLength: 40, error: 'Write a name' }) }), async ({ name }, ctx) => {
  await db.repo(Member).write.findOrCreate({ name: name.trim() }, ['name'])
  await ctx.locals.session.regenerate()
  await ctx.locals.session.set('name', name.trim())
  ctx.redirect('/account')
})
---
head
  title Sign in
h1${tw('.text-2xl.font-bold')} Sign in
p${tw('.text-subtext1')} A demo: any name signs in. Replace it with real credentials before going live.
form${tw('.mt-4.flex.flex-col.items-start.gap-2')}(action={signIn})
  label(for="name") Name
  input#name(name="name" autocomplete="username")
  if signIn.error('name') as error
    p${tw('.text-error')} {error}
  button(type="submit") Sign in
`,
    'src/routes/account/_guard.ts': `import { guard } from 'kay'

// Everything under /account is for signed-in visitors.
export default guard(async ({ locals, redirect }) => {
  if (await locals.session.get('name') === undefined)
    redirect('/login')
})
`,
    'src/routes/account/index.kay': `--- server
import { s } from 'kay'
import { db } from '../../db'
import { Member } from '../../db/member'

export const signOut = action(s.Object({}), async (_input, ctx) => {
  await ctx.locals.session.destroy()
  ctx.redirect('/')
})

const name = await ctx.locals.session.get('name')
const member = name === undefined ? null : await db.repo(Member).read.findOne({ name })
---
head
  title Account
h1${tw('.text-2xl.font-bold')} Signed in as {name}
if member
  p${tw('.text-subtext1')} Member since {member.joined_at.toLocaleDateString('en', { dateStyle: 'long' })}
form${tw('.mt-4')}(action={signOut})
  button(type="submit") Sign out
`,
  }
}

const AUTH_TEST_FILES: Record<string, string> = {
  // Read by `bun test` only, so tests run in a fresh clone and CI; never a real secret. Each test file gets a copy of this database, which need not exist.
  '.env.test': 'SESSION_SECRET=only-for-tests-0123456789abcdefghijklmnop\nDATABASE_URL=postgres://app:app@127.0.0.1:5433/app_test\n',
  'tests/database.ts': `import process from 'node:process'
import { testDatabase } from '@kaynooo/pg-orm'
import { afterAll } from 'bun:test'
import { Member } from '../src/db/member'

// Before each test file, run with \`bun test --isolate\`: a copy of the database the migrations build, with what the seed adds, dropped once the file is done.
const database = await testDatabase({
  url: process.env.DATABASE_URL!,
  migrationsDir: 'migrations',
  tables: [Member],
  seed: async (db) => {
    await db.repo(Member).write.insertOne({ name: 'Ada', joined_at: new Date('2024-01-01T12:00:00Z') })
  },
})

// Read by src/env.ts, which the test file imports after this.
process.env.DATABASE_URL = database.url

afterAll(async () => {
  await database.drop()
})
`,
  'tests/members.test.ts': `import { expect, it } from 'bun:test'
import { db } from '../src/db'
import { Member } from '../src/db/member'

// Whatever another test file signed in, this one starts from the seed alone: tests/database.ts copies a database per file.
it('starts from the seed, with no member another test file added', async () => {
  await db.repo(Member).write.insertOne({ name: 'Linus' })

  expect((await db.repo(Member).read.findMany(q => q.orderBy('name', 'asc'))).map(member => member.name)).toEqual(['Ada', 'Linus'])
})
`,
  'tests/account.test.ts': `import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { signIn } from '../src/routes/login.kay'
import { sessions } from '../src/session'

const site = await testSite({ use: [sessions] })

afterAll(async () => {
  await site.close()
})

it('sends a visitor to sign in, then into their account', async () => {
  expect((await site.visit('/account')).url).toBe('/login')
  expect((await site.submit(signIn, { name: 'Grace' }, { from: '/login' })).html).toContain('Signed in as Grace')
})

it('knows a member from the seed, and since when', async () => {
  expect((await site.submit(signIn, { name: 'Ada' }, { from: '/login' })).html).toContain('Member since January 1, 2024')
})
`,
}

// An API module and a live island over its websocket.
function wsFiles({ tw }: Setup): Record<string, string> {
  return {
    'src/api/online.ts': `import { s } from 'kay'
import { api } from 'kay/server'

let online = 0

// Served at /api/online: every open connection hears how many there are.
export default api().ws('/', {
  response: s.Object({ online: s.Number() }),
  open(ws) {
    online++
    ws.subscribe('online')
    ws.send({ online })
    ws.publish('online', { online })
  },
  close(ws) {
    online--
    ws.publish('online', { online })
  },
})
`,
    'src/components/online.kay': `---
import { socket } from 'kay'
import online from '../api/online'

const live = socket(online, '/')
---
p${tw('.text-subtext1')} {live.status() === 'open' ? \`\${live.last()?.online ?? 1} online now\` : 'Connecting...'}
`,
  }
}

const WS_TEST = `import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import online from '../src/api/online'

const site = await testSite()

afterAll(async () => {
  await site.close()
})

it('tells every visitor how many are online', async () => {
  const first = site.socket(online, '/')

  expect(await first.next()).toEqual({ online: 1 })

  const second = site.socket(online, '/')

  expect(await second.next()).toEqual({ online: 2 })
  expect(await first.next()).toEqual({ online: 2 })

  second.close()
  expect(await first.next()).toEqual({ online: 1 })
  first.close()
})
`

// The project's AGENTS.md, naming the checks its scripts run. Claude Code expands the `@` line into kay's docs as installed, other agents read it as a path.
export function agentsFile(scripts: Record<string, string>): string {
  const checks = ['check', 'fmt', 'lint', 'test'].filter(script => script in scripts).map(script => `\`bun run ${script}\``)

  return blocks(
    '# __NAME__',
    'Built with kay, a Bun web framework: a `.kay` file is one component, TypeScript fences then a pug-like template. Read kay\'s docs for the installed version before writing kay code; the topic files they link are in `node_modules/kay/llms/`:',
    '@node_modules/kay/llms.txt',
    `Before calling a change done, run ${new Intl.ListFormat('en').format(checks)}.`,
  )
}

// Every file but package.json, tsconfig.json and the agents' instructions, which `createProject` writes from the same features and scripts.
export function templateFiles(features: ReadonlySet<Feature>, settings: ConfigSettings = {}): Record<string, string> {
  const has = (feature: Feature) => features.has(feature)
  const setup: Setup = { has, tw: classes => has('tailwind') ? classes : '', settings }
  const server = has('server')

  return {
    // kay itself is published there, as are @kaynooo/eslint and @kaynooo/pg-orm.
    '.npmrc': `@kaynooo:registry=${REGISTRY}\n`,
    '.gitignore': lines('node_modules', '.kay', has('eslint') && '.eslintcache', server ? '/server' : 'dist', has('auth') && '.env'),
    'kay.config.ts': config(setup),
    'src/routes/_layout.kay': layout(setup),
    'src/routes/index.kay': home(setup),
    ...has('tailwind') && { 'src/app.css': tailwindCss(setup) },
    ...has('starter') && !has('tailwind') && { 'src/app.css': PLAIN_CSS },
    ...has('starter') && starterFiles(setup),
    ...has('accents') && ACCENT_FILES,
    ...server && { 'src/server.ts': SERVER_ENTRY },
    // Type-aware, .kay fences included, once `kay check` or `kay dev` has written the types they read.
    ...has('eslint') && { 'eslint.config.ts': 'import { defineConfig } from \'@kaynooo/eslint\'\n\nexport default defineConfig({ strict: true, kay: true })\n' },
    ...has('tests') && {
      // `kay/test/preload` lets test files import pages and their actions; an app's `tests/database.ts` gives each test file a database of its own.
      'bunfig.toml': has('auth') ? '[test]\npreload = [\n  "kay/test/preload",\n  "./tests/database.ts",\n]\n' : '[test]\npreload = [ "kay/test/preload" ]\n',
      'tests/home.test.ts': homeTest(setup),
    },
    ...has('ci') && (server ? { '.forgejo/workflows/test.yml': testWorkflow(setup) } : { '.forgejo/workflows/pages.yml': pagesWorkflow(setup) }),
    ...has('docker') && (server ? serverContainerFiles(setup) : staticContainerFiles(setup)),
    ...has('auth') && authFiles(setup),
    ...has('auth') && has('tests') && AUTH_TEST_FILES,
    ...has('ws') && wsFiles(setup),
    ...has('ws') && has('tests') && { 'tests/online.test.ts': WS_TEST },
  }
}
