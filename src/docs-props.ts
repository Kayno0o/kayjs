// The props a component of an installed kayjs-* library declares, read from its installed `.kay` source, as `kay docs <Component>` prints them.
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { installedLibraries } from './docs-search'

const NAME = /^[A-Z][\w-]*$/i
const HYPHEN = /-/g
const KEBAB_PART = /(?:^|-)([a-z\d])/g
const TYPE_NAME = /^\w+$/
// The call taking the props: not `myprops<`, not on a comment line.
const PROPS_CALL = /^(?!\s*(?:\/\/|\/\*|\*)).*?(?<![\w$.])props</m
// What joins the type names a component may take its props as, `AsButton | AsLink`.
const TYPE_JOIN = /[|&]/
const RELATIVE = /^\.\.?\//

export interface ComponentProps {
  // `FormDialog`
  name: string
  // `@kaynooo/kayjs-ui/form-dialog.kay`
  specifier: string
  path: string
  // 1-based, of the statement taking the props
  line: number
  // The statement taking the props, then the types it names that the file or a module it imports declares; empty for a component taking none.
  props: string
}

// The exported components a single word names, its case and hyphens aside (`FormDialog`, `form-dialog`), one per library exporting one.
export function componentProps(root: string, query: string): ComponentProps[] {
  const word = query.trim()

  if (!NAME.test(word))
    return []

  const key = word.toLowerCase().replace(HYPHEN, '')

  return installedLibraries(root).flatMap(([name, dir]) => components(name, dir).filter(([, path]) => basename(path, '.kay').replace(HYPHEN, '') === key).slice(0, 1)).map(([specifier, path]) => ({
    name: basename(path, '.kay').replace(KEBAB_PART, (_, letter: string) => letter.toUpperCase()),
    specifier,
    path,
    ...propsOf(path),
  }))
}

// A manifest that does not parse exports nothing, rather than failing the search.
function readManifest(path: string): { exports?: Record<string, unknown> } {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { exports?: Record<string, unknown> }
  }
  catch {
    return {}
  }
}

// Each `.kay` file a package exports, by the specifier an app imports it with.
function components(name: string, dir: string): [string, string][] {
  const manifestPath = join(dir, 'package.json')
  const manifest = existsSync(manifestPath) ? readManifest(manifestPath) : {}
  const found: [string, string][] = []

  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    if (!key.endsWith('.kay') || typeof value !== 'string')
      continue

    const star = value.indexOf('*')

    if (star === -1) {
      found.push([`@kaynooo/${name}/${key.slice(2)}`, join(dir, value)])

      continue
    }

    const [prefix, suffix] = [value.slice(2, star), value.slice(star + 1)]

    for (const file of new Bun.Glob(value.slice(2)).scanSync({ cwd: dir }))
      found.push([`@kaynooo/${name}/${key.slice(2).replace('*', file.slice(prefix.length, file.length - suffix.length))}`, join(dir, file)])
  }

  return found.sort(([a], [b]) => a.localeCompare(b))
}

function propsOf(path: string): { line: number, props: string } {
  const source = readFileSync(path, 'utf8')
  const found = PROPS_CALL.exec(source)
  const call = found === null ? -1 : found.index + found[0].length - 'props<'.length

  if (call === -1)
    return { line: 1, props: '' }

  const open = call + 'props'.length
  const close = closing(source, open)
  const start = Math.max(source.lastIndexOf('\nconst ', call), source.lastIndexOf('\nexport const ', call)) + 1
  const statement = source.slice(start, source.startsWith('()', close + 1) ? close + 3 : close + 1)
  const type = source.slice(open + 1, close).trim()
  const names = type.split(TYPE_JOIN).map(name => name.trim())
  const declared = names.every(name => TYPE_NAME.test(name)) ? names.map(name => declaration(source, name) ?? importedDeclaration(source, name, path)).filter(found => found !== undefined).join('\n\n') : ''

  return { line: source.slice(0, start).split('\n').length, props: declared === '' ? statement : `${statement}\n\n${declared}` }
}

// The bracket closing the one at `open`, past strings, comments and the `>` of an arrow.
function closing(source: string, open: number): number {
  let depth = 0

  for (let index = open; index < source.length; index++) {
    const char = source[index]!

    if (char === '\'' || char === '"' || char === '`') {
      index = source.indexOf(char, index + 1)

      if (index === -1)
        return source.length
    }
    else if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = source[index + 1] === '/' ? source.indexOf('\n', index) : source.indexOf('*/', index + 2) + 1

      if (index <= 0)
        return source.length
    }
    else if (char === '<' || char === '{' || char === '(' || char === '[') {
      depth++
    }
    else if ((char === '>' && source[index - 1] !== '=') || char === '}' || char === ')' || char === ']') {
      depth--

      if (depth === 0)
        return index
    }
  }

  return source.length
}

// `interface Name { ... }` or `type Name = ...` as the source writes it: to the brace closing the one on its first line, else that line alone.
function declaration(file: string, name: string): string | undefined {
  // A line break before the first line, so that a declaration opening the file is found as any other.
  const source = `\n${file}`
  const at = [`\nexport interface ${name} `, `\ninterface ${name} `, `\nexport type ${name} `, `\ntype ${name} `].map(head => source.indexOf(head)).find(index => index !== -1)

  if (at === undefined)
    return undefined

  const start = at + 1
  const newline = source.indexOf('\n', start)
  const lineEnd = newline === -1 ? source.length : newline
  const brace = source.indexOf('{', start)

  return source.slice(start, brace !== -1 && brace < lineEnd ? closing(source, brace) + 1 : lineEnd).trimEnd()
}

// The declaration of a type the component imports from a relative module of its package.
function importedDeclaration(source: string, name: string, path: string): string | undefined {
  const from = new RegExp(`(?:import|export) (?:type )?\\{[^}]*\\b${name}\\b[^}]*\\} from '([^']+)'`).exec(source)?.[1]

  if (from === undefined || !RELATIVE.test(from))
    return undefined

  const module = [`${from}.ts`, from, `${from}/index.ts`].map(file => join(dirname(path), file)).find(file => existsSync(file) && file.endsWith('.ts'))

  return module === undefined ? undefined : declaration(readFileSync(module, 'utf8'), name)
}

// Where a component is, for a reader to open it.
export function componentPlace(component: ComponentProps, root: string): string {
  return `${relative(root, component.path)}:${component.line}`
}
