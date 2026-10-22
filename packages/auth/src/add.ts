interface Project {
  name: string
  exists: (path: string) => boolean
  read: (path: string) => string | undefined
  depends: (name: string) => boolean
}

const NAME_TAIL = /[^\p{L}\p{N}]+/u
const SCOPE = /^@[^/]+\//
const TABLES = /(export const tables = \[)(\s*)(\]?)/
const MAIL_REGISTERED = /\bmail(?:Extension)?\(/

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

// What `kay add auth` writes: src/auth.ts over the project's database or a SQLite file of its own, the extension with the prebuilt pages, a guard on the whole site and the session secret.
export default function auth(project: Project) {
  const ownDatabase = project.exists('src/db/index.ts') && project.depends('@kaynooo/pg-orm') && project.read('src/db/index.ts')?.includes('export const db') === true
  // A project kay new scaffolded keeps the tables apart from `db`, so pg-orm.config.ts reads them without building `db`.
  const tablesFile = project.read('src/db/tables.ts')?.includes('export const tables') === true ? 'src/db/tables.ts' : 'src/db/index.ts'
  const mailed = project.exists('src/mail.ts') && project.read('src/mail.ts')?.includes('export const mail') === true
  // kayjs-mail registered in kay.config.ts brings the wording and views of authMailer; without it the mail library only sends kayjs-auth's own html.
  const themed = mailed && MAIL_REGISTERED.test(project.read('kay.config.ts') ?? '')
  const imports = [
    'import type { AuthSessionData } from \'@kaynooo/kayjs-auth\'',
    'import { createAuth } from \'@kaynooo/kayjs-auth\'',
    ownDatabase ? 'import { pgStore } from \'@kaynooo/kayjs-auth/pg\'' : 'import { authTables, pgStore } from \'@kaynooo/kayjs-auth/pg\'',
    ...themed ? ['import { authMailer } from \'@kaynooo/kayjs-mail\''] : [],
    ...ownDatabase ? [] : ['import { Database } from \'@kaynooo/pg-orm\''],
    'import { session } from \'kay/server\'',
    ...ownDatabase ? ['import { db } from \'./db\''] : [],
    ...mailed ? ['import { mail } from \'./mail\''] : [],
  ]

  const database = ownDatabase
    ? ''
    : '\n// A SQLite file of its own, created below; point `url` at Postgres, or add `...authTables` to the tables of the app\'s own `Database`, for the app\'s database.\nexport const db = new Database({ url: \'sqlite://data/auth.db\', tables: [...authTables] })\n\nawait db.sync()\n'

  const source = `${imports.join('\n')}\n${database}
export const auth = createAuth({
  sessions: session<AuthSessionData>(),
  store: pgStore(db),
  name: '${siteName(project.name)}',
  pages: true,${mailed ? `\n  email: { mailer: ${themed ? 'authMailer(mail.enqueue)' : '{ send: mail.enqueue }'} },` : ''}
})
`

  return {
    description: 'sign-in, register and account pages on kay sessions, with passwords, magic links, OAuth and two-factor, and every page behind a signed-in user',
    files: {
      'src/auth.ts': source,
      'src/routes/_guard.ts': 'import { auth } from \'../auth\'\n\n// Every page below needs a signed-in visitor; the sign-in and register pages stay open. Delete this file for a public site, or move it into the folder to protect.\nexport default auth.guard()\n',
    },
    edits: ownDatabase
      ? [{ file: tablesFile, find: TABLES, replace: withAuthTables, done: '...authTables', import: 'import { authTables } from \'@kaynooo/kayjs-auth/pg\'' }]
      : [],
    example: ['KAY_SECRET', 'SITE_URL'],
    ignore: ownDatabase ? [] : ['data'],
    extension: { import: 'import { auth } from \'@kaynooo/kayjs-auth\'', expression: 'auth({ module: \'./src/auth\' })' },
    notes: [
      ownDatabase ? 'Run your migration generator (bun run db:generate) for the auth_* tables kayjs-auth added to the tables.' : 'kayjs-auth keeps its users in data/auth.db: point the Database in src/auth.ts at Postgres before production.',
      ...mailed ? [] : ['Without a mailer, password resets, magic links and verification mails cannot be sent: run `kay add mail` and pass `email: { mailer: authMailer(mail.enqueue) }` to createAuth.'],
      'Set KAY_SECRET and SITE_URL in production.',
    ],
  }
}
