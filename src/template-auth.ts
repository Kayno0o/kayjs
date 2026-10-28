import type { Setup } from './template-shared'
import { APP_ROLES_SCRIPT } from './template-docker'
import { POSTGRES_IMAGE } from './template-pins'

// kayjs-auth, the files `kay add auth` writes: sign-in, register and account pages on kay sessions, every page behind a signed-in visitor. Its users live in a SQLite file of its own, or in the app's Postgres with `postgres`.
export function authFiles({ has }: Setup): Record<string, string> {
  const postgres = has('postgres')

  return {
    // What production sets, for compose.prod.yaml; development's own settings are in the .env `kay new` wrote.
    '.env.example': `# Each one generated and kept out of the repository: \`bun -e "console.log((crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', ''))"\`.\nKAY_SECRET=\nSITE_URL=\n${postgres ? 'POSTGRES_PASSWORD=\nAPP_DB_PASSWORD=\n' : 'KAYJS_AUTH_DATABASE_URL=\n'}`,
    'src/routes/_guard.ts': `import { guard } from '@kaynooo/kayjs-auth'

// Every page below needs a signed-in visitor; the sign-in and register pages stay open. Delete this file for a public site, or move it into the folder to protect.
export default guard()
`,
    ...postgres && postgresFiles(),
  }
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
    image: ${POSTGRES_IMAGE}
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
export function authTestFiles({ has }: Setup): Record<string, string> {
  return has('postgres') ? { '.env.test': 'DATABASE_URL=postgres://app:app@127.0.0.1:5433/app_test\n' } : {}
}
