interface Project {
  name: string
  exists: (path: string) => boolean
  read: (path: string) => string | undefined
  depends: (name: string) => boolean
}

const NAME_TAIL = /[^\p{L}\p{N}]+/u
const SCOPE = /^@[^/]+\//
const TABLES = /(export const tables = \[)(\s*)(\]?)/

// Puts authTables first in the list: alone in an empty one, on a line of its own in a multi-line one, ahead of the others otherwise.
function withAuthTables(_match: string, open: string, space: string, close: string): string {
  if (close !== '')
    return `${open}...authTables${close}`

  return space.includes('\n') ? `${open}${space}...authTables,${space}` : `${open}${space}...authTables, `
}

// The site's name for mails and authenticator apps, from the package name.
function siteName(name: string): string {
  const words = name.replace(SCOPE, '').split(NAME_TAIL).filter(word => word !== '')

  return words.map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ') || 'My site'
}

// What `kay add auth` writes: `auth({ ... })` in kay.config.ts, which builds everything else, and a guard on the whole site. A project with a pg-orm `Database` of its own keeps the users there, through a `store` function loading it as the server starts; any other keeps them in a SQLite file.
export default function auth(project: Project) {
  const ownDatabase = project.exists('src/db/index.ts') && project.depends('@kaynooo/pg-orm') && project.read('src/db/index.ts')?.includes('export const db') === true
  // A project kay new scaffolded keeps the tables apart from `db`, so pg-orm.config.ts reads them without building `db`.
  const tablesFile = project.read('src/db/tables.ts')?.includes('export const tables') === true ? 'src/db/tables.ts' : 'src/db/index.ts'
  const mailed = project.exists('src/mail.ts') && project.read('src/mail.ts')?.includes('export const mail') === true

  return {
    description: 'sign-in, register and account pages on kay sessions, with passwords, magic links, OAuth and two-factor, and every page behind a signed-in user',
    files: {
      'src/routes/_guard.ts': authGuard(),
    },
    edits: ownDatabase
      ? [{ file: tablesFile, find: TABLES, replace: withAuthTables, done: '...authTables', import: 'import { authTables } from \'@kaynooo/kayjs-auth/pg\'' }]
      : [],
    example: authExample(ownDatabase),
    ignore: ownDatabase ? [] : ['data'],
    extension: { import: 'import { auth } from \'@kaynooo/kayjs-auth\'', expression: authCall(siteName(project.name), ownDatabase) },
    notes: [
      ownDatabase ? 'Run your migration generator (bun run db:generate) for the kay_* tables kayjs-auth added to the tables.' : 'kayjs-auth keeps its users in data/auth.db: set KAYJS_AUTH_DATABASE_URL (a Postgres url) before production.',
      ...mailed ? [] : ['Without a mailer, password resets, magic links and verification mails cannot be sent: run `kay add mail`, and auth() sends through it.'],
      'Set KAY_SECRET and SITE_URL in production.',
    ],
  }
}

// The `.env.example` keys: the session secret and the site's address, and the database url of the SQLite default.
function authExample(ownDatabase: boolean): string[] {
  return ['KAY_SECRET', 'SITE_URL', ...ownDatabase ? [] : ['KAYJS_AUTH_DATABASE_URL']]
}

// The `auth()` of kay.config.ts: the name mails and authenticator apps show, and over the app's own database a store loading it as the server starts, so the config stays off the database.
function authCall(name: string, ownDatabase: boolean): string {
  const store = ownDatabase ? ', store: async () => (await import(\'@kaynooo/kayjs-auth/pg\')).pgStore((await import(\'./src/db\')).db)' : ''

  return `auth({ name: '${name}'${store} })`
}

// The root guard: every page below needs a signed-in visitor; the sign-in and register pages stay open.
function authGuard(): string {
  return 'import { guard } from \'@kaynooo/kayjs-auth\'\n\n// Every page below needs a signed-in visitor; the sign-in and register pages stay open. Delete this file for a public site, or move it into the folder to protect.\nexport default guard()\n'
}
