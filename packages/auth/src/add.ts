
interface Project {
  name: string
  exists: (path: string) => boolean
  read: (path: string) => string | undefined
  depends: (name: string) => boolean
}

const NAME_TAIL = /[^a-z0-9]+/i
const SCOPE = /^@[^/]+\//
const TABLES = /(export const tables = \[)/

// The site's name for mails and authenticator apps, from the package name.
function siteName(name: string): string {
  const words = name.replace(SCOPE, '').split(NAME_TAIL).filter(word => word !== '')

  return words.map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ') || 'My site'
}

// What `kay add auth` writes: src/auth.ts over the project's database or a SQLite file of its own, the extension with the prebuilt pages, a guard on the whole site and the session secret.
export default function auth(project: Project) {
  const ownDatabase = project.exists('src/db/index.ts') && project.depends('@kaynooo/pg-orm') && project.read('src/db/index.ts')?.includes('export const db') === true
  const mailed = project.exists('src/mail.ts') && project.read('src/mail.ts')?.includes('export const mail') === true
  const imports = [
    'import type { AuthSessionData } from \'@kaynooo/kayjs-auth\'',
    'import process from \'node:process\'',
    'import { createAuth } from \'@kaynooo/kayjs-auth\'',
    ownDatabase ? 'import { pgStore } from \'@kaynooo/kayjs-auth/pg\'' : 'import { authTables, pgStore } from \'@kaynooo/kayjs-auth/pg\'',
    ...ownDatabase ? [] : ['import { Database } from \'@kaynooo/pg-orm\''],
    'import { session } from \'kay/server\'',
    ...ownDatabase ? ['import { db } from \'./db\''] : [],
    ...mailed ? ['import { mail } from \'./mail\''] : [],
  ]

  const database = ownDatabase
    ? ''
    : '\n// A SQLite file of its own, created below; point `url` at Postgres, or add `...authTables` to the tables of the app\'s own `Database`, for the app\'s database.\nexport const db = new Database({ url: \'sqlite://data/auth.db\', tables: authTables })\n\nawait db.sync()\n'

  const source = `${imports.join('\n')}\n${database}
export const auth = createAuth({
  sessions: session<AuthSessionData>(),
  store: pgStore(db),
  site: ${JSON.stringify(siteName(project.name))},
  pages: true,${mailed ? '\n  email: { mailer: { send: mail.enqueue } },' : ''}
})
`

  return {
    description: 'sign-in, register and account pages on kay sessions, with passwords, magic links, OAuth and two-factor, and every page behind a signed-in user',
    files: {
      'src/auth.ts': source,
      'src/routes/_guard.ts': 'import { auth } from \'../auth\'\n\n// Every page below needs a signed-in visitor; the sign-in and register pages stay open. Delete this file for a public site, or move it into the folder to protect.\nexport default auth.guard()\n',
    },
    edits: ownDatabase
      ? [{ file: 'src/db/index.ts', find: TABLES, replace: '$1...authTables, ', done: '...authTables', import: 'import { authTables } from \'@kaynooo/kayjs-auth/pg\'' }]
      : [],
    example: ['KAY_SECRET', 'SITE_URL'],
    ignore: ownDatabase ? [] : ['data'],
    extension: { import: 'import { authPages } from \'@kaynooo/kayjs-auth\'', expression: 'authPages({ auth: () => import(\'./src/auth\') })' },
    notes: [
      ownDatabase ? 'Run your migration generator (bun run db:generate) for the auth_* tables kayjs-auth added to the tables.' : 'kayjs-auth keeps its users in data/auth.db: point the Database in src/auth.ts at Postgres before production.',
      ...mailed ? [] : ['Without a mailer, password resets, magic links and verification mails cannot be sent: run `kay add mail` and pass `email: { mailer: { send: mail.enqueue } }` to createAuth.'],
      'Set KAY_SECRET and SITE_URL in production.',
    ],
  }
}
