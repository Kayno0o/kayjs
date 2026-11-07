import type { Feature } from './template-shared'

// What `kay new --with` and `kay add` both take, in the order the picker lists them, each with what it cannot go without. A feature with `packages` is a library's: `kay add` installs them and writes what the first one's `add` export says, and `kay new` does the same after it scaffolds the rest, except for a `templated` one (`auth`), whose files the templates write. `brings` are the library features it brings along, which checking it in the picker checks too.
export const FEATURES: Record<Feature, { description: string, needs: readonly Feature[], packages?: readonly string[], brings?: readonly Feature[], templated?: true }> = {
  server: { description: 'an Elysia server, run in production as one executable; off, a static site built to dist', needs: [] },
  starter: { description: 'a header, a 404 page, and a home page greeting from the server with a counter island', needs: [] },
  tailwind: { description: 'Tailwind over the Catppuccin Mocha palette', needs: [] },
  accents: { description: 'an accent picker in the header, kept in a cookie', needs: ['starter', 'tailwind'] },
  eslint: { description: 'ESLint through @kaynooo/eslint, .kay fences and template expressions included', needs: [] },
  tests: { description: 'kay test through kay/test, with a first test', needs: [] },
  ci: { description: 'a Forgejo or GitHub workflow checking, linting and testing the server, or publishing the static site to Pages', needs: [] },
  docker: { description: 'a Dockerfile and compose.prod.yaml running the executable, or nginx serving the static site', needs: [] },
  auth: { description: 'kayjs-auth: sign-in, register and account pages on kay sessions, every page behind a signed-in user, its users in a SQLite file', needs: ['server', 'tailwind'], packages: ['@kaynooo/kayjs-auth', '@kaynooo/kayjs-ui', '@iconify-json/tabler', '@kaynooo/pg-orm'], brings: ['ui'], templated: true },
  postgres: { description: 'kayjs-auth\'s users in Postgres instead of SQLite: a compose stack for development, roles and migrations as an owner', needs: ['auth'] },
  ws: { description: 'an API module over a websocket, with an island counting the visitors online', needs: ['server'] },
  ai: { description: 'kayjs-ai: ask(), an LLM called with no SDK, streaming into await blocks and actions, answered by a scripted fake in development and tests', needs: [], packages: ['@kaynooo/kayjs-ai'] },
  mail: { description: 'kayjs-mail: a mailer reading SMTP from the environment, with the outbox page in development', needs: [], packages: ['@kaynooo/kayjs-mail'] },
  cms: { description: 'kayjs-cms: collection screens under /admin, and content edited on the page it renders', needs: [], packages: ['@kaynooo/kayjs-cms', '@kaynooo/kayjs-ui', '@iconify-json/tabler'] },
  ui: { description: 'kayjs-ui: the theme, one Toaster and one TooltipHost for every page, with no line in the layout or app.css', needs: ['tailwind'], packages: ['@kaynooo/kayjs-ui', '@iconify-json/tabler'] },
}

export const FEATURE_NAMES = Object.keys(FEATURES) as Feature[]
