import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { detectFeatures } from './add'

const KINDS = ['page', 'component', 'island', 'action', 'api', 'guard'] as const

type Kind = typeof KINDS[number]

// A route segment: a name, a `[param]` or `[...rest]`, or a `(group)`; a component or module name is a plain one.
const PLAIN = /^[a-z0-9][\w-]*$/i
const ROUTE_SEGMENT = /^(?:[a-z0-9][\w-]*|\[(?:\.\.\.)?[a-z]\w*\]|\([a-z][\w-]*\))$/i
const ACTION_NAME = /^[a-z][a-z0-9]*$/i
const WORD_BREAK = /[-_]+/g
// Words an action cannot be exported as, or that its own file already names: the `action` and `s` it calls, `title` its handler reads.
const RESERVED = new Set(['action', 's', 'title', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield'])
// The `_actions.kay` fence an action is added to, for the hint printed when the file exists.
const ACTION_BODY = (name: string) => `export const ${name} = action(\n  s.Object({ title: s.String({ minLength: 1, maxLength: 200 }) }),\n  ({ title }) => title,\n)\n`
const DYNAMIC = /[[(]/
const LEADING_DIGIT = /^\d/
const DASH_LETTER = /-(\w)/g

function sentence(slug: string): string {
  const words = slug.replace(WORD_BREAK, ' ').trim()

  return words.charAt(0).toUpperCase() + words.slice(1)
}

function slugOf(path: string): string {
  return path.replaceAll('/', '-').replace(/[[\]().]/g, '')
}

function segmentsOf(kind: Kind, name: string): string[] {
  const segments = name.split('/').filter(segment => segment !== '')
  const valid = kind === 'page' ? ROUTE_SEGMENT : PLAIN

  if (segments.length === 0 || segments.some(segment => !valid.test(segment)))
    throw new Error(`kay generate: \`${name}\` is not a name for a ${kind}: write ${kind === 'page' ? 'segments of letters, digits, `-` and `_`, a `[param]` or a `(group)`' : 'letters, digits, `-` and `_`'}, separated by \`/\``)

  return segments
}

// The route a page file serves, `/` for the home page; `undefined` when a param makes it more than one URL.
function urlOf(segments: readonly string[]): string | undefined {
  const parts = segments.filter(segment => !segment.startsWith('(') && segment !== 'index')

  return parts.some(part => DYNAMIC.test(part)) ? undefined : `/${parts.join('/')}`
}

const TEST_HEAD = 'import { expect, it } from \'bun:test\'\nimport { testSite } from \'kay/test\'\n'

function pageFiles(segments: readonly string[], tailwind: boolean, tests: boolean, auth: boolean): Record<string, string> {
  const last = segments.at(-1)!
  const title = sentence(last === 'index' ? segments.at(-2) ?? 'Home' : last)
  const route = segments.join('/')
  const url = urlOf(segments)
  const files: Record<string, string> = {
    [`src/routes/${route}.kay`]: `head\n  title ${title}\nh1${tailwind ? '.text-3xl.font-bold' : ''} ${title}\n`,
  }

  if (tests && url !== undefined) {
    // kayjs-auth guards every page, so a visitor with no session lands on its sign-in page.
    const assertions = auth ? '  expect(page.url).toStartWith(\'/auth/sign-in\')' : `  expect(page.status).toBe(200)\n  expect(page.text('h1')).toBe('${title}')`

    files[`tests/${slugOf(route)}.test.ts`] = `${TEST_HEAD}\nconst site = await testSite()\n\nit('renders ${url}', async () => {\n  const page = await site.visit('${url}')\n\n${assertions}\n})\n`
  }

  return files
}

function actionFiles(segments: readonly string[], tests: boolean, auth: boolean): Record<string, string> {
  const name = segments.at(-1)!

  if (!ACTION_NAME.test(name) || RESERVED.has(name))
    throw new Error(`kay generate: \`${name}\` is not a name for an action: write letters and digits that are no reserved word, such as \`removeTissue\``)

  const folder = segments.slice(0, -1).join('/')
  const file = `src/routes/${folder === '' ? '' : `${folder}/`}_actions.kay`
  const files: Record<string, string> = {
    [file]: `--- server\nimport { s } from 'kay'\n\n${ACTION_BODY(name)}`,
  }

  if (tests && !auth) {
    const imported = `../${file.slice(0, -'.kay'.length)}.kay`

    files[`tests/action-${slugOf(segments.join('/'))}.test.ts`] = `${TEST_HEAD}import { ${name} } from '${imported}'\n\nconst site = await testSite()\n\nit('answers a valid ${name}', async () => {\n  expect(await site.call(${name}, { title: 'First' })).toBe('First')\n})\n\nit('refuses an empty title', async () => {\n  const refused = await site.refusal(${name}, { title: '' })\n\n  expect(refused.status).toBe(422)\n})\n`
  }

  return files
}

function apiFiles(segments: readonly string[], tests: boolean, auth: boolean): Record<string, string> {
  const route = segments.join('/')
  const files: Record<string, string> = {
    [`src/api/${route}.ts`]: 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => ({ ok: true }))\n',
  }

  if (tests && !auth) {
    const identifier = segments.at(-1)!.replace(DASH_LETTER, (_, letter: string) => letter.toUpperCase()).replace(LEADING_DIGIT, digit => `_${digit}`)

    files[`tests/api-${slugOf(route)}.test.ts`] = `${TEST_HEAD}import ${identifier} from '../src/api/${route}'\n\nconst site = await testSite()\n\nit('answers /api/${route}', async () => {\n  const answer = await site.api(${identifier}, '/')\n\n  expect(answer.ok).toBe(true)\n})\n`
  }

  return files
}

function guardFiles(segments: readonly string[]): Record<string, string> {
  return {
    [`src/routes/${segments.map(segment => `${segment}/`).join('')}_guard.ts`]: 'import { guard } from \'kay\'\n\n// Runs before every page and action in this folder and below: redirect or deny here, such as `return deny(403, "Admins only")`.\nexport default guard(() => undefined)\n',
  }
}

// The files `kay generate <kind> <name>` writes, by path from the project root. Tailwind adds its shorthand classes to a page, and a project with tests gets a test of a page, an action or an API module, which a guard, a component or an island has no URL of its own to be tested at.
export function generatedFiles(kind: Kind, name: string, project: { tailwind: boolean, tests: boolean, auth: boolean }): Record<string, string> {
  // `/` names the root guard, which every page and action sits below.
  const segments = kind === 'guard' && name === '/' ? [] : segmentsOf(kind === 'guard' ? 'page' : kind, name)

  switch (kind) {
    case 'page':
      return pageFiles(segments, project.tailwind, project.tests, project.auth)
    case 'component':
      return { [`src/components/${segments.join('/')}.kay`]: '---\nconst { label } = props<{ label: string }>()\n---\np {label}\n' }
    case 'island':
      return { [`src/components/${segments.join('/')}.kay`]: '---\nconst count = signal(0)\n---\nbutton(onClick={() => count++}) Clicked {count()} times\n' }
    case 'action':
      return actionFiles(segments, project.tests, project.auth)
    case 'api':
      return apiFiles(segments, project.tests, project.auth)
    case 'guard':
      return guardFiles(segments)
  }
}

// The other file that serves the same URL as a page file: `pricing.kay` and `pricing/index.kay` both serve /pricing, which `kay check` refuses.
function rivalRoutes(page: string): string[] {
  const base = page.slice(0, -'.kay'.length)

  return base.endsWith('/index') ? [`${base.slice(0, -'/index'.length)}.kay`] : [`${base}/index.kay`]
}

// Writes what `kay generate` makes into the project in `dir`, never over a file that exists: one that does stops it with nothing written.
export async function generate(dir: string, kind: string, name: string, options: { dryRun?: boolean | undefined } = {}): Promise<{ written: string[] }> {
  if (!KINDS.includes(kind as Kind))
    throw new Error(`kay generate: ${kind} is none of ${KINDS.join(', ')}`)

  if (!existsSync(join(dir, 'package.json')))
    throw new Error(`kay generate: ${dir} has no package.json: run it in a project`)

  const features = await detectFeatures(dir)
  const files = generatedFiles(kind as Kind, name, { tailwind: features.has('tailwind'), tests: features.has('tests'), auth: features.has('auth') })
  const taken = [...Object.keys(files), ...kind === 'page' ? rivalRoutes(Object.keys(files)[0]!) : []].filter(path => existsSync(join(dir, path)))

  if (taken.length > 0) {
    const hint = taken.some(path => path.endsWith('_actions.kay')) ? `: add the action to its server fence by hand, from this shape:\n\n${ACTION_BODY(name.split('/').at(-1)!)}` : ''

    throw new Error(`kay generate: nothing was written, ${taken.join(', ')} already exist${taken.length === 1 ? 's' : ''}${hint}`)
  }

  if (options.dryRun !== true) {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), text, { flag: 'wx' })
    }
  }

  return { written: Object.keys(files) }
}
