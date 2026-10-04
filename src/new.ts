import type { Template } from './templates'
import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { chmod, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { TEMPLATE_FILES } from './templates'

// The kay this command runs from: a git checkout, which a new project depends on a packed copy of, or the published package.
const KAY_ROOT = resolve(import.meta.dir, '..')
const INVALID_NAME_CHARS = /[^a-z0-9._~-]+/g
const NAME_EDGES = /^[-._~]+|[-._~]+$/g

export type { Template }

export const TEMPLATES: readonly Template[] = ['server', 'site', 'app']

export interface NewOptions {
  // The \`kay\` dependency: by default the published kay running this command, or a packed copy of the checkout running it.
  kay?: string
  // `server` by default, an Elysia app serving the pages, run in production as one executable; `site`, a static site built to files; `app`, the server with sessions, a sign-in, a guarded section and a websocket.
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
  const template = options.template ?? 'server'
  const site = template === 'site'
  const devDependencies = Object.fromEntries(['@iconify-json/tabler', '@types/bun', 'bun-plugin-tailwind', 'tailwindcss'].map(name => [name, kay.devDependencies[name]!]))
  const files: Record<string, string> = {
    ...TEMPLATE_FILES[template],
    'package.json': `${JSON.stringify({
      name,
      type: 'module',
      private: true,
      scripts: site ? { dev: 'kay dev', build: 'kay build --static', check: 'kay check', fmt: 'kay fmt', test: 'bun test' } : { dev: 'kay dev', build: 'kay build', compile: 'kay build --compile server', start: 'NODE_ENV=production bun src/server.ts', check: 'kay check', fmt: 'kay fmt', test: 'bun test' },
      dependencies: { elysia: kay.dependencies.elysia, kay: dependency },
      devDependencies,
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

  // The app's session secret, for development and its tests, never committed.
  if (template === 'app')
    files['.env'] = `SESSION_SECRET=${randomBytes(32).toString('hex')}\n`

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(dir, path), content.replaceAll('__NAME__', name))))

  // The session secret is for its owner's eyes only.
  if (template === 'app')
    await chmod(join(dir, '.env'), 0o600)

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
