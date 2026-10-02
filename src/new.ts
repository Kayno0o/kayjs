import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'

// The checkout this command runs from, which a new project depends on until kay is published.
const KAY_ROOT = resolve(import.meta.dir, '..')

// Written as strings rather than template files, which the repository's own `.kay` scans would pick up.
const FILES: Record<string, string> = {
  '.gitignore': 'node_modules\n.kay\n',
  'kay.config.ts': `import { defineConfig } from 'kay/server'

export default defineConfig({ lang: 'en' })
`,
  'src/server.ts': `import process from 'node:process'
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

const app = new Elysia().use(await pages()).listen(Number(process.env.PORT ?? 3000))

console.log(\`Listening on http://localhost:\${app.server?.port}\`)
`,
  'src/app.css': `body {
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

export interface NewOptions {
  // The \`kay\` dependency, \`file:\` this checkout unless given.
  kay?: string
}

// Scaffolds a project that \`kay dev\` runs and \`kay check\` passes as it is; refuses a directory that already holds files.
export async function createProject(target: string, options: NewOptions = {}): Promise<string[]> {
  const dir = resolve(target)

  if (existsSync(dir) && (await readdir(dir)).length > 0)
    throw new Error(`kay: ${target} is not empty`)

  const name = basename(dir)
  const dependency = options.kay ?? await packKay(join(dir, 'vendor'))
  const kay = await Bun.file(join(KAY_ROOT, 'package.json')).json() as { dependencies: Record<string, string>, devDependencies: Record<string, string> }
  const files: Record<string, string> = {
    ...FILES,
    'package.json': `${JSON.stringify({
      name,
      type: 'module',
      private: true,
      scripts: { dev: 'kay dev', build: 'kay build', start: 'NODE_ENV=production bun src/server.ts', check: 'kay check', fmt: 'kay fmt' },
      dependencies: { elysia: kay.dependencies.elysia, kay: dependency },
      devDependencies: { '@types/bun': kay.devDependencies['@types/bun'] },
    }, null, 2)}\n`,
    'tsconfig.json': `${JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        lib: ['ESNext', 'DOM', 'DOM.Iterable'],
        jsx: 'preserve',
        jsxImportSource: '@solidjs/web',
        module: 'Preserve',
        moduleResolution: 'bundler',
        rootDirs: ['.', '.kay/types'],
        types: ['bun'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['src', 'kay.config.ts', '.kay/types'],
    }, null, 2)}\n`,
  }

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(dir, path), content.replaceAll('__NAME__', name))))

  return Object.keys(files).sort()
}

// A packed copy installs like a published package, its dependencies only; a `file:` folder would drag in its devDependencies too.
async function packKay(vendor: string): Promise<string> {
  const child = Bun.spawn([process.execPath, 'pm', 'pack', '--quiet', '--destination', vendor], { cwd: KAY_ROOT, stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    throw new Error(`kay: packing ${KAY_ROOT} failed\n${errors}`)

  return `file:./vendor/${basename(output.trim())}`
}
