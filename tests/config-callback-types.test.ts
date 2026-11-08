import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { kayCheck } from './check-helper'
import { kayTypes } from './kay-types'
import { scratchDir } from './scratch'

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, paths: kayTypes() },
  include: ['src', '.kay/types', 'kay.config.ts'],
})

// The compiler `kay lint` runs, TypeScript itself: `kay check` runs tsgo, which did not report the cycle these configs made.
async function tsc(root: string): Promise<string> {
  const run = Bun.spawn([process.execPath, join(import.meta.dir, '../node_modules/typescript/bin/tsc'), '-p', root], { stdout: 'pipe', stderr: 'pipe' })

  return `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`
}

const CONFIG = `import { Elysia } from 'elysia'
import { defineConfig } from 'kay/server'

export default defineConfig({
  images: {
    resolve: async (src: string, ctx): Promise<string> => \`\${ctx.locals.user.name}\${ctx.locals.role}\${src}\`,
    guard: (ctx): void => {
      const wrong: number = ctx.locals.role

      if (!wrong)
        ctx.deny(401)
    },
  },
  extensions: [{ name: 'lib', server: new Elysia({ name: 'lib' }).derive({ as: 'scoped' }, () => ({ role: 'admin' })) }],
})
`

it('types a config whose images callbacks take a request context, ctx.locals of the app and of its extensions staying typed', async () => {
  const root = await scratchDir('config-callback-')
  const user = 'const user = new Elysia({ name: \'user\' }).derive({ as: \'scoped\' }, () => ({ user: { name: \'Ada\' } }))\n'

  await Promise.all(Object.entries({
    'tsconfig.json': TSCONFIG,
    'kay.config.ts': CONFIG,
    'src/server.ts': `import { Elysia } from 'elysia'\nimport { pages } from 'kay/server'\n\n${user}\nexport const app = new Elysia().use(user).use(await pages())\n`,
    'src/routes/index.kay': '--- server\nconst name: string = ctx.locals.user.name\nconst role: string = ctx.locals.role\n---\np {name} {role}\n',
  }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  const checked = await kayCheck([root])

  // Only the planted mismatch, which a config typed `any` would not report.
  expect(checked.output).toContain('Type \'string\' is not assignable to type \'number\'')
  expect(checked.output).not.toContain('TS7022')
  const compiled = await tsc(root)

  expect(compiled).toContain('kay.config.ts(8,13): error TS2322')
  expect(compiled).not.toContain('TS7022')
  expect(compiled.match(/error TS/g)).toHaveLength(1)
}, 120_000)

it('reports the cycle a callback makes by returning what it reads off ctx.locals unannotated, which the config\'s own type depends on', async () => {
  const root = await scratchDir('config-callback-')
  const config = CONFIG.replace('async (src: string, ctx): Promise<string> =>', 'async (src: string, ctx) =>')

  await Promise.all(Object.entries({
    'tsconfig.json': TSCONFIG,
    'kay.config.ts': config,
    'src/routes/index.kay': 'p hi\n',
  }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  const checked = await kayCheck([root])

  expect(checked.code).toBe(1)
  expect(checked.output).toContain('TS7023')
}, 120_000)
