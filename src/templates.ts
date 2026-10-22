// The files `kay new` writes, `__NAME__` standing for the package name. Written as strings rather than template files, which the repository's own `.kay` scans would pick up.

export type Feature = 'server' | 'starter' | 'tailwind' | 'accents' | 'eslint' | 'tests' | 'ci' | 'docker' | 'auth' | 'postgres' | 'ws'

// What kay.config.ts sets beyond the features, for a project migrated from a site that already had them.
export interface ConfigSettings {
  lang?: string | undefined
  site?: string | undefined
  base?: string | undefined
  // The `seo` defaults, left out where the pages already write their own titles and descriptions.
  seo?: boolean | undefined
  // The `fonts` entries of the installed Fontsource packages the site served.
  fonts?: { fontsource: string, weights?: number[] | undefined, styles?: string[] | undefined, subsets?: string[] | undefined }[] | undefined
}

// Where the project's repository is hosted, which decides the CI it is scaffolded with.
export type Host = 'forgejo' | 'github'

// The runner label each host's jobs run on unless `kay new --runner` names another.
export const DEFAULT_RUNNERS: Record<Host, string> = { forgejo: 'debian', github: 'ubuntu-latest' }

// The features a project is scaffolded with, as the files ask for them.
interface Setup {
  has: (feature: Feature) => boolean
  host: Host
  // The label of the runner the CI jobs run on: the host's own image unless `kay new --runner` names another.
  runner: string
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

// A class of the `.class` shorthand: a balanced `[...]`, a `(...)` after a `-`, a decimal, or any other character that is no space, `.`, `#` or `(`.
const SHORTHAND_CLASS = String.raw`(?:\[[^\]\s]*\]|(?<=-)\([^)\s]*\)|\d\.\d+(?!\w)|[^\s.#(\[\]])+`

// Tailwind IntelliSense's `classRegex`: a `class="..."` value, and the classes after the tag and the `#id` of a line or of a `#[tag]`, each `.class` apart.
// A regex cannot tell a fence from the template, so a script line such as `console.log(` reads as a tag with a class too.
export const TAILWIND_CLASS_REGEX: (string | [string, string])[] = [
  String.raw`class\s*=\s*"([^"]*)"`,
  [String.raw`(?:^|\n|#\[)[ \t]*(?:[A-Za-z][\w-]*)?(?:#[^\s.#(\[\]]+)?((?:\.${SHORTHAND_CLASS})+)`, String.raw`\.(${SHORTHAND_CLASS})`],
]

// `.vscode/settings.json`: the ESLint extension lints only the languages it lists, which replaces its default ones, and Tailwind IntelliSense reads `.kay` as HTML.
function editorSettings({ has }: Setup): Record<string, unknown> {
  return {
    ...has('eslint') && { 'eslint.validate': ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'kay'] },
    ...has('tailwind') && { 'tailwindCSS.includeLanguages': { kay: 'html' }, 'tailwindCSS.experimental.classRegex': TAILWIND_CLASS_REGEX },
  }
}

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
  div(
    class="absolute right-0 mt-2 grid grid-cols-7 gap-1 rounded border-2 border-overlay0 bg-mantle p-2 shadow-lg"
    role="radiogroup"
    aria-label="Accent colour"
  )
    for name of ACCENTS
      button.grid.size-6.place-items-center.rounded.border-2.border-overlay0.p-0(type="button" role="radio" aria-label={name} aria-checked={currentAccent() === name ? 'true' : 'false'} style={\`background-color: var(--accent-\${name})\`} onClick={() => accent.set(name)})
        if currentAccent() === name
          Check.size-4.text-base
`,
}

function header({ has, tw }: Setup): string {
  const links = has('auth') ? '[{ href: \'/\', label: \'Home\' }, { href: \'/auth/account\', label: \'Account\' }]' : '[{ href: \'/\', label: \'Home\' }]'

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
      has('auth') && 'a(href="/auth/account") Account',
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
button(onClick={() => count++}) Clicked {count()} times
`,
    'src/routes/_404.kay': notFoundPage(setup),
  }
}

function notFoundPage(setup: Setup): string {
  return lines('head', '  title Nothing here', `h1${setup.tw('.text-2xl.font-bold')} Nothing here`, 'a(href="/") Back home')
}

function homeTest({ has }: Setup): string {
  // kayjs-auth guards every page, so a visitor with no session lands on its sign-in page.
  if (has('auth')) {
    return `import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite()

it('sends a visitor to sign in', async () => {
  const home = await site.visit('/')

  expect(home.status).toBe(200)
  expect(home.url).toStartWith('/auth/sign-in')
})
`
  }

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
    has('auth') && 'import { auth } from \'@kaynooo/kayjs-auth\'',
    has('auth') && 'import { ui } from \'@kaynooo/kayjs-ui/extension\'',
    !server && 'import process from \'node:process\'',
    has('tailwind') && 'import tailwind from \'bun-plugin-tailwind\'',
    'import { defineConfig } from \'kay/server\'',
    '',
    !server && '// Set when building, as the Pages workflow does: the path the site is published under; kay reads the host it is published on from SITE_URL.',
    'export default defineConfig({',
    has('auth') && '  extensions: [auth({ module: \'./src/auth\' }), ui()],',
    `  lang: ${quote(settings.lang ?? 'en')},`,
    settings.site !== undefined && `  site: ${quote(settings.site)},`,
    server ? base !== undefined && `  base: ${base},` : `  base: process.env.SITE_BASE${base === undefined ? '' : ` ?? ${base}`},`,
    has('tailwind') && '  plugins: [tailwind],',
    settings.fonts !== undefined && settings.fonts.length > 0 && `  fonts: [${settings.fonts.map(font => `{ fontsource: ${quote(font.fontsource)}${font.weights ? `, weights: [${font.weights.join(', ')}]` : ''}${font.styles ? `, styles: [${font.styles.map(quote).join(', ')}]` : ''}${font.subsets ? `, subsets: [${font.subsets.map(quote).join(', ')}]` : ''} }`).join(', ')}],`,
    server && has('docker') && '  // The compose file binds 127.0.0.1 for a reverse proxy: with this the visitor\'s address, which rate limits count, is the one the proxy passes on and not the proxy\'s. It trusts private-range peers, so a dev server bound to 0.0.0.0 believes a LAN client\'s X-Forwarded-For.',
    server && has('docker') && '  proxy: true,',
    settings.seo !== false && '  seo: { name: \'__NAME__\', titleTemplate: \'%s | __NAME__\', description: \'__NAME__, made with kay\' },',
    '})',
  )
}

const SERVER_ENTRY = `import process from 'node:process'
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

// Exported for \`kay check\`, which checks links against the routes it serves besides the pages and types \`ctx.locals\` from its plugins.
export const app = new Elysia().use(await pages()).listen({ port: Number(process.env.PORT ?? 3000), ...process.env.HOST !== undefined && { hostname: process.env.HOST } })
`

// Actions are pinned to a commit with the release it is, so a moved tag cannot change what a workflow runs; each SHA is the commit its tag names in the action's repository.
const CHECKOUT = '11d5960a326750d5838078e36cf38b85af677262 # v4.4.0'
const SETUP_BUN_V1 = 'f4d14e03ff726c06358e5557344e1da148b56cf7 # v1.2.2'
const SETUP_BUN_V2 = '0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0'
const UPLOAD_PAGES_ARTIFACT = '56afc609e74202658d3ffba0e8f6dda462b719fa # v3.0.1'
const DEPLOY_PAGES = 'd6db90164ac5ed86f2b6aed7e0febac5b3c0c03e # v4.0.5'
const GH_PAGES = '373f7f263a76c20808c831209c920827a82a2847 # v3.9.3'

// The Forgejo runner image carries neither unzip nor git, which GitHub's hosted runners do.
function workflowSetup(host: Host): string {
  return `${host === 'forgejo'
    ? `      - name: Install unzip and git
        run: apt-get update && apt-get install -y unzip git

`
    : ''}      - name: Checkout
        uses: actions/checkout@${CHECKOUT}

      - name: Setup Bun
        uses: oven-sh/setup-bun@${host === 'forgejo' ? SETUP_BUN_V1 : SETUP_BUN_V2}
        with:
          bun-version: ${Bun.version}

      - name: Install dependencies
        run: bun install --frozen-lockfile`
}

// Every push is checked and tested before anything deploys it; the container build checks again, as `kay build` does. With `postgres`, the tests copy a database per test file on a Postgres service.
function testWorkflow({ has, host, runner }: Setup): string {
  const database = has('postgres') && has('tests')

  return blocks(
    `name: ${has('tests') ? 'Tests' : 'Checks'}

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ${runner}${database
      ? `
    services:
      postgres:
        image: postgres:18-alpine
        env:
          POSTGRES_USER: app
          POSTGRES_PASSWORD: app
          POSTGRES_DB: app_test${host === 'github'
            ? `
        ports:
          - 5432:5432`
            : ''}
        options: --health-cmd "pg_isready -h 127.0.0.1 -U app" --health-interval 2s --health-retries 15`
      : ''}
    steps:
${workflowSetup(host)}`,
    `      # Each problem shows on the diff.
      - name: Check
        run: bun run check --format github`,
    has('eslint') && `      - name: Lint
        run: bun run lint`,
    has('tests') && `      - name: Test
        run: bun run test${database
          ? `
        env:
          DATABASE_URL: postgres://app:app@${host === 'forgejo' ? 'postgres' : 'localhost'}:5432/app_test`
          : ''}`,
  )
}

// A site with no server: `kay build --static` writes it to `dist`, which this workflow publishes to Forgejo Pages, or to GitHub Pages.
function pagesWorkflow({ has, host, runner }: Setup): string {
  const github = host === 'github'

  return blocks(
    `name: Publish to Pages

on:
  push:
    branches:
      - main

${github
  ? `permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  publish:
    runs-on: ${runner}
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}`
  : `permissions:
  contents: write

jobs:
  publish:
    runs-on: ${runner}`}
    steps:
${workflowSetup(host)}`,
    has('tests') && `      # A failing test publishes nothing; the build checks the project itself.
      - name: Test
        run: bun run test`,
    `${has('tests') ? '' : '      # The build checks the project itself.\n'}      - name: Build the site
        env:${github
          ? `
          SITE_URL: https://\${{ github.repository_owner }}.github.io
          SITE_BASE: /\${{ github.event.repository.name }}`
          : `
          # The host your Forgejo instance publishes Pages on: replace it with yours.
          SITE_URL: https://pages.example.com
          SITE_BASE: /\${{ github.repository }}`}
        run: bun run build`,
    has('eslint') && `      - name: Lint
        run: bun run lint`,
    github
      ? `      # Set Pages to deploy from GitHub Actions in the repository's settings; a site named <owner>.github.io is served from the root, so empty SITE_BASE.
      - name: Upload the site
        uses: actions/upload-pages-artifact@${UPLOAD_PAGES_ARTIFACT}
        with:
          path: dist

      - name: Publish to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@${DEPLOY_PAGES}`
      : `      - name: Publish to the gitea-pages branch
        uses: peaceiris/actions-gh-pages@${GH_PAGES}
        with:
          github_token: \${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
          publish_branch: gitea-pages
          force_orphan: true`,
  )
}

// Run by the database image once, as it creates the database: a second role that reads and writes rows but changes no schema, and the default privileges that hand it every table, sequence and schema the owner creates later.
// It is idempotent, so an existing database adopts it by running this same file once (see the upgrading guide).
export const APP_ROLES_SCRIPT = `#!/bin/sh
# Run by the database image when it first creates the database, and by hand on an existing one: docker compose exec -T db sh /docker-entrypoint-initdb.d/roles.sh
# The role the app connects with, so a SQL injection or a compromised app process cannot drop or alter a table; $POSTGRES_USER, the owner, stays with the migrations.
# Tables, sequences and schemas the owner creates later reach it through default privileges, so a migration needs no GRANT.
set -e
[ -n "$APP_DB_PASSWORD" ] || { echo 'set APP_DB_PASSWORD, the password of the app_rw role' >&2; exit 1; }

psql -v ON_ERROR_STOP=1 -v owner="$POSTGRES_USER" -v password="$APP_DB_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT 'CREATE ROLE app_rw LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') \\gexec
-- Creating an event trigger and changing the SUPERUSER, REPLICATION and BYPASSRLS attributes take a superuser: on a managed Postgres the owner is not one, and the script finishes without them (a role it creates has none of them anyway).
SELECT rolsuper AS is_super FROM pg_roles WHERE rolname = current_user \\gset
\\if :is_super
SELECT format('ALTER ROLE app_rw NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'password') \\gexec
\\else
SELECT format('ALTER ROLE app_rw PASSWORD %L', :'password') \\gexec
\\endif
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" GRANT USAGE ON SEQUENCES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" GRANT USAGE ON SCHEMAS TO app_rw;

-- pg-orm's migration history table is created after this script, so the default privileges reach it: the revoke below covers one that exists already, and an event trigger takes the writes back from one created later.
SELECT format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %s FROM app_rw', oid::regclass) FROM pg_class WHERE relname = '_pgorm_migrations' AND relkind = 'r' \\gexec
\\if :is_super
CREATE OR REPLACE FUNCTION public.kay_protect_migrations() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE created record;
BEGIN
  FOR created IN SELECT object_identity FROM pg_event_trigger_ddl_commands() WHERE command_tag = 'CREATE TABLE' AND object_identity ~ '\\._pgorm_migrations$' AND EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %s FROM app_rw', created.object_identity);
  END LOOP;
END
$$;
DROP EVENT TRIGGER IF EXISTS kay_protect_migrations;
CREATE EVENT TRIGGER kay_protect_migrations ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.kay_protect_migrations();
\\else
\\warn 'db/roles.sh: the owner is not a superuser, so the event trigger that keeps app_rw from writing _pgorm_migrations is skipped: revoke INSERT, UPDATE, DELETE on it after the first migrate.'
\\endif
SQL
`

// An app's database, and a one-shot service applying the migrations before the app starts.
// The app connects as app_rw, which reads and writes rows; the owner role stays with the migrations.
const APP_COMPOSE = `services:
  db:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      # Letters and digits only: it goes into DATABASE_URL below as it is.
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: app
      # The password of app_rw, the role the app connects with: a different secret from the owner's, letters and digits only as well.
      APP_DB_PASSWORD: \${APP_DB_PASSWORD:?set APP_DB_PASSWORD}
    volumes:
      - db:/var/lib/postgresql
      # Creates app_rw when the database is first created; db/roles.sh says how to run it on an existing one.
      - ./db/roles.sh:/docker-entrypoint-initdb.d/roles.sh:ro
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
      # The owner: only the migrations change the schema.
      MIGRATE_DATABASE_URL: postgres://app:\${POSTGRES_PASSWORD}@db:5432/app
    depends_on:
      db:
        condition: service_healthy

  app:
    build: .
    restart: unless-stopped
    # This machine alone: the reverse proxy in front serves the site over HTTPS.
    ports:
      - 127.0.0.1:3000:3000
    environment:
      # At least 32 characters, kept out of the repository: it seals the sessions.
      KAY_SECRET: \${KAY_SECRET:?set KAY_SECRET}
      DATABASE_URL: postgres://app_rw:\${APP_DB_PASSWORD}@db:5432/app
      # The public origin of the site, which the mailed links and the OAuth callbacks start from.
      SITE_URL: \${SITE_URL:?set SITE_URL}
    depends_on:
      migrate:
        condition: service_completed_successfully

volumes:
  db:
`

// An app on SQLite: kayjs-auth's file lives on a volume, which the app creates its tables in when it starts.
const SQLITE_COMPOSE = `services:
  app:
    build: .
    restart: unless-stopped
    # This machine alone: the reverse proxy in front serves the site over HTTPS.
    ports:
      - 127.0.0.1:3000:3000
    environment:
      # At least 32 characters, kept out of the repository: it seals the sessions.
      KAY_SECRET: \${KAY_SECRET:?set KAY_SECRET}
      # The public origin of the site, which the mailed links and the OAuth callbacks start from.
      SITE_URL: \${SITE_URL:?set SITE_URL}
    volumes:
      - data:/app/data

volumes:
  data:
`

function databaseCompose(postgres: boolean): string {
  return postgres ? APP_COMPOSE : SQLITE_COMPOSE
}

// The binary `kay build --compile` makes carries the pages, their assets and the browser build, so the image holds it alone.
function serverContainerFiles({ has }: Setup): Record<string, string> {
  // kayjs-auth's SQLite file is written under `data`, which the image holds for the volume compose mounts there.
  const data = has('auth') && !has('postgres')

  return {
    'Dockerfile': `FROM oven/bun:${Bun.version} AS build
WORKDIR /app
COPY package.json bun.lock* .npmrc ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run compile

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/server ./server
${data ? 'RUN mkdir data && chown nobody data\n' : ''}ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER nobody
HEALTHCHECK --interval=30s --timeout=6s CMD ["./server", "--health"]
CMD ["./server"]
`,
    '.dockerignore': `node_modules\n.kay\nserver\n.git\n.env\n.env.*\n${data ? 'data\n' : ''}`,
    'compose.prod.yaml': has('auth')
      ? databaseCompose(has('postgres'))
      : `services:
  app:
    build: .
    restart: unless-stopped
    # This machine alone: the reverse proxy in front serves the site over HTTPS.
    ports:
      - 127.0.0.1:3000:3000
`,
  }
}

// The static site's container: the same files, served by nginx with the compressed copies the build wrote, and a 404 page for a path it lacks.
function staticContainerFiles(setup: Setup): Record<string, string> {
  const { has } = setup

  return {
    // The 404 page nginx serves is the one the export writes from this file.
    ...!has('starter') && { 'src/routes/_404.kay': notFoundPage(setup) },
    'Dockerfile': `FROM oven/bun:${Bun.version} AS build
WORKDIR /app
COPY . .
# The stock nginx image cannot send brotli, so only the gzip copies are kept; the headers the build wrote go where nginx.conf includes them from, out of the served folder.
RUN bun install --frozen-lockfile && bun run build && find dist -name '*.br' -delete && mv dist/headers.nginx.conf kay-headers.conf && rm -f dist/_headers

# The unprivileged build runs as a user of its own and listens on 8080, so the container needs no root nor a port below 1024.
FROM nginxinc/nginx-unprivileged:1.31-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build /app/kay-headers.conf /etc/nginx/kay-headers.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
`,
    'nginx.conf': `server {
  listen 8080;
  root /usr/share/nginx/html;
  server_tokens off;
  gzip_static on;
  gzip_vary on;
  add_header Strict-Transport-Security "max-age=31536000" always;
  include /etc/nginx/kay-headers.conf;

  # Hashed files, immutable; the search manifest and the notices keep their name between builds, so they revalidate.
  location ^~ /_kay/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Strict-Transport-Security "max-age=31536000" always;
    include /etc/nginx/kay-headers.conf;
  }

  location = /_kay/search.json {
    add_header Cache-Control "no-cache";
    add_header Strict-Transport-Security "max-age=31536000" always;
    include /etc/nginx/kay-headers.conf;
  }

  location = /_kay/THIRD-PARTY-LICENSES.txt {
    add_header Cache-Control "no-cache";
    add_header Strict-Transport-Security "max-age=31536000" always;
    include /etc/nginx/kay-headers.conf;
  }

  location ~* \\.(?:woff2?|ttf|otf|eot)$ {
    add_header Cache-Control "public, max-age=2592000";
    add_header Strict-Transport-Security "max-age=31536000" always;
    include /etc/nginx/kay-headers.conf;
  }

  location ~* \\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)$ {
    add_header Cache-Control "public, max-age=86400";
    add_header Strict-Transport-Security "max-age=31536000" always;
    include /etc/nginx/kay-headers.conf;
  }

  location / {
    try_files $uri $uri.html $uri/index.html =404;
  }

  error_page 404 /404.html;
}
`,
    '.dockerignore': 'node_modules\n.kay\ndist\n.git\n.env\n.env.*\n',
  }
}

// kayjs-auth, the files `kay add auth` writes: sign-in, register and account pages on kay sessions, every page behind a signed-in visitor. Its users live in a SQLite file of its own, or in the app's Postgres with `postgres`.
function authFiles({ has }: Setup): Record<string, string> {
  const postgres = has('postgres')

  return {
    // What production sets, for compose.prod.yaml; development's own settings are in the .env `kay new` wrote.
    '.env.example': `# Each one generated and kept out of the repository: \`bun -e "console.log((crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', ''))"\`.\nKAY_SECRET=\nSITE_URL=\n${postgres ? 'POSTGRES_PASSWORD=\nAPP_DB_PASSWORD=\n' : ''}`,
    'src/auth.ts': authModule(postgres),
    'src/routes/_guard.ts': `import { auth } from '../auth'

// Every page below needs a signed-in visitor; the sign-in and register pages stay open. Delete this file for a public site, or move it into the folder to protect.
export default auth.guard()
`,
    ...postgres && postgresFiles(),
  }
}

// What `kay add auth` writes as src/auth.ts, over the app's own database with `postgres` and a SQLite file of its own without.
function authModule(postgres: boolean): string {
  const imports = [
    'import type { AuthSessionData } from \'@kaynooo/kayjs-auth\'',
    'import { createAuth } from \'@kaynooo/kayjs-auth\'',
    postgres ? 'import { pgStore } from \'@kaynooo/kayjs-auth/pg\'' : 'import { authTables, pgStore } from \'@kaynooo/kayjs-auth/pg\'',
    ...postgres ? [] : ['import { Database } from \'@kaynooo/pg-orm\''],
    'import { session } from \'kay/server\'',
    ...postgres ? ['import { db } from \'./db\''] : [],
  ]
  const database = postgres
    ? ''
    : '\n// A SQLite file of its own, created below; point `url` at Postgres, or add `...authTables` to the tables of the app\'s own `Database`, for the app\'s database.\nexport const db = new Database({ url: \'sqlite://data/auth.db\', tables: [...authTables] })\n\nawait db.sync()\n'

  return `${imports.join('\n')}\n${database}
export const auth = createAuth({
  sessions: session<AuthSessionData>(),
  store: pgStore(db),
  name: '__SITE__',
  pages: true,
})
`
}

// kayjs-auth's tables in a Postgres of the app's own, which a migration creates: the owner changes the schema, the app connects as app_rw.
function postgresFiles(): Record<string, string> {
  return {
    'src/db/tables.ts': `import { authTables } from '@kaynooo/kayjs-auth/pg'

// Add the app's own tables beside kayjs-auth's; a change goes to the database as a migration: \`bun run db:generate\`, then \`bun run db:migrate\`.
// pg-orm.config.ts reads them from here, not from ./index: importing \`db\` there would build it on DATABASE_URL before \`kay/test/preload\` points it at the file's copy.
export const tables = [...authTables]
`,
    'src/db/index.ts': `import process from 'node:process'
import { Database } from '@kaynooo/pg-orm'
import { tables } from './tables'

// Connects on the first query; in a test, to the copy \`kay/test/preload\` made for the file.
export const db = new Database({ url: process.env.DATABASE_URL!, tables })
`,
    'pg-orm.config.ts': `import process from 'node:process'
import { Database, defineConfig } from '@kaynooo/pg-orm'
import { tables } from './src/db/tables'

// For the \`pg-orm\` command: \`bun run db:generate\` writes a migration from what the tables declare, \`bun run db:migrate\` applies the pending ones.
export default defineConfig({
  // The owner, which changes the schema; the app itself connects as app_rw through DATABASE_URL.
  db: new Database({ url: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL, tables }),
  migrationsDir: 'migrations',
})
`,
    // `bun run db:generate` writes the first migration, for kayjs-auth's tables as the installed version declares them.
    'migrations/.gitkeep': '',
    'db/roles.sh': APP_ROLES_SCRIPT,
    'compose.dev.yaml': `# The database for development and tests: \`docker compose up -d --wait\`, which .env points at this file. Tests copy a database per test file on it.
services:
  db:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
      APP_DB_PASSWORD: app_rw
    ports:
      - 127.0.0.1:5433:5432
    volumes:
      - db:/var/lib/postgresql
      - ./db/roles.sh:/docker-entrypoint-initdb.d/roles.sh:ro
    # What --wait waits for, so the migrations run on a database that answers, over TCP: on its first start the image's server listens on its socket only.
    healthcheck:
      test: [CMD-SHELL, pg_isready -h 127.0.0.1 -U app]
      interval: 2s
      retries: 15

volumes:
  db:
`,
  }
}

// Read by `bun test` only, so tests run in a fresh clone and CI; never a real secret. With `postgres`, each test file gets a copy of the database.
function authTestFiles({ has }: Setup): Record<string, string> {
  return has('postgres') ? { '.env.test': 'DATABASE_URL=postgres://app:app@127.0.0.1:5433/app_test\n' } : {}
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

const WS_TEST = `import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import online from '../src/api/online'

const site = await testSite()

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

// The project's AGENTS.md, naming the checks its scripts run. Claude Code expands the `@` line into kay's docs as installed, other agents read it as a path. With `seo`, it names the folder name every title ends with, which an agent otherwise leaves as it is.
export function agentsFile(scripts: Record<string, string>, seo: boolean): string {
  const checks = ['check', 'fmt', 'lint', 'test'].filter(script => script in scripts).map(script => `\`bun run ${script}\``)

  return blocks(
    '# __NAME__',
    'Built with kay, a Bun web framework: a `.kay` file is one component, TypeScript fences then a pug-like template. Read kay\'s docs for the installed version before writing kay code; the topic files they link are in `node_modules/kay/llms/`:',
    '@node_modules/kay/llms.txt',
    seo && 'Every page title ends with `seo.name` from `kay.config.ts`, which `kay new` filled in from the folder name: set it to the site\'s real name.',
    `Before calling a change done, run ${new Intl.ListFormat('en').format(checks)}.`,
  )
}

// Every file but package.json, tsconfig.json and the agents' instructions, which `createProject` writes from the same features and scripts.
export function templateFiles(features: ReadonlySet<Feature>, settings: ConfigSettings = {}, host: Host = 'forgejo', runner: string = DEFAULT_RUNNERS[host]): Record<string, string> {
  const has = (feature: Feature) => features.has(feature)
  const setup: Setup = { has, host, runner, tw: classes => has('tailwind') ? classes : '', settings }
  const server = has('server')

  return {
    // kay itself is published there, as are @kaynooo/eslint and @kaynooo/pg-orm.
    '.npmrc': `@kaynooo:registry=${REGISTRY}\n`,
    '.gitignore': lines('node_modules', '.kay', has('eslint') && '.eslintcache', server ? '/server' : 'dist', has('auth') && !has('postgres') && 'data', '.env', '.env.*', '!.env.example', '!.env.test'),
    'kay.config.ts': config(setup),
    'src/routes/_layout.kay': layout(setup),
    'src/routes/index.kay': home(setup),
    ...has('tailwind') && { 'src/app.css': tailwindCss(setup) },
    ...has('starter') && !has('tailwind') && { 'src/app.css': PLAIN_CSS },
    ...has('starter') && starterFiles(setup),
    ...has('accents') && ACCENT_FILES,
    ...server && { 'src/server.ts': SERVER_ENTRY },
    ...(has('eslint') || has('tailwind')) && { '.vscode/settings.json': `${JSON.stringify(editorSettings(setup), null, 2)}\n` },
    // Type-aware, .kay fences included, over the types `kay lint`, `kay check` and `kay dev` write.
    ...has('eslint') && { 'eslint.config.ts': 'import { defineConfig } from \'@kaynooo/eslint\'\n\nexport default defineConfig({ strict: true, kay: true })\n' },
    ...has('tests') && {
      // `kay/test/preload` lets test files import pages and their actions, and gives each one a database of its own when the app has a pg-orm.config.ts.
      'bunfig.toml': '[test]\npreload = [ "kay/test/preload" ]\n',
      'tests/home.test.ts': homeTest(setup),
    },
    ...has('ci') && { [`.${host}/workflows/${server ? 'test' : 'pages'}.yml`]: server ? testWorkflow(setup) : pagesWorkflow(setup) },
    ...has('docker') && (server ? serverContainerFiles(setup) : staticContainerFiles(setup)),
    ...has('auth') && authFiles(setup),
    ...has('auth') && has('tests') && authTestFiles(setup),
    ...has('ws') && wsFiles(setup),
    ...has('ws') && has('tests') && { 'tests/online.test.ts': WS_TEST },
  }
}
