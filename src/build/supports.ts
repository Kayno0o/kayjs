import type { BunPlugin, PluginBuilder } from 'bun'
import { CSS_FILE } from './files'
import { readingAs, referenceable, withReferences } from './references'

const SUPPORTS_PRELUDE = /^@supports\b/i
const SPACES = /\s+/g

export const COMMENTS = /\/\*[\s\S]*?\*\//g
// An unquoted `url(`, whose contents may hold any brace or semicolon.
const URL_OPEN = /^url\([^'"\s]/i

export type Node = { text: string } | { prelude: string, body: Node[] }

// The stylesheet as text runs and blocks, each block its prelude (what leads to its `{`, the whitespace and comments before included) and what it holds; strings, comments and `url()` are read past whole, so a brace in one is not one.
export function parse(css: string): Node[] {
  let at = 0
  const read = (depth: number): Node[] => {
    const nodes: Node[] = []
    let start = at
    // Where the prelude of a block opening next starts: after the last `;` of this run.
    let statement = at

    while (at < css.length) {
      const char = css[at]!

      if (char === '/' && css[at + 1] === '*') {
        const end = css.indexOf('*/', at + 2)

        at = end === -1 ? css.length : end + 2
      }
      else if (char === '"' || char === '\'') {
        at++

        while (at < css.length && css[at] !== char && css[at] !== '\n')
          at += css[at] === '\\' ? 2 : 1

        at++
      }
      else if ((char === 'u' || char === 'U') && URL_OPEN.test(css.slice(at, at + 5))) {
        const end = css.indexOf(')', at + 4)

        at = end === -1 ? css.length : end + 1
      }
      else if (char === '\\') {
        at += 2
      }
      else if (char === ';') {
        at++
        statement = at
      }
      else if (char === '{') {
        if (statement > start)
          nodes.push({ text: css.slice(start, statement) })

        const prelude = css.slice(statement, at)

        at++

        const body = read(depth + 1)

        nodes.push({ prelude, body })
        start = at
        statement = at
      }
      // A `}` closing nothing is text, which Bun reports as it would without the merge.
      else if (char === '}' && depth > 0) {
        if (at > start)
          nodes.push({ text: css.slice(start, at) })

        at++

        return nodes
      }
      else {
        at++
      }
    }

    if (at > start)
      nodes.push({ text: css.slice(start) })

    return nodes
  }

  return read(0)
}

export function print(nodes: Node[]): string {
  return nodes.map(node => 'text' in node ? node.text : `${node.prelude}{${print(node.body)}}`).join('')
}

// What a block merges by, written one way: the condition of an `@supports` block, or inside a rule the selector of a nested rule; undefined for any other block, a custom property whose value is a block among them.
function mergeKey(node: Node, inRule: boolean): string | undefined {
  if ('text' in node)
    return undefined

  const prelude = node.prelude.replace(COMMENTS, '').trim().replace(SPACES, ' ')

  if (SUPPORTS_PRELUDE.test(prelude))
    return prelude.replace(SUPPORTS_PRELUDE, '@supports')

  return inRule && !prelude.startsWith('@') && !prelude.endsWith(':') ? prelude : undefined
}

// Puts what `from` holds at the end of `into`, a `;` between when `into` ends on a declaration that has none.
function append(into: Node[], from: Node[]): void {
  const last = into.findLast(node => !('text' in node) || node.text.replace(COMMENTS, '').trim() !== '')

  if (last !== undefined && 'text' in last && !last.text.replace(COMMENTS, '').trim().endsWith(';'))
    into.push({ text: ';' })

  into.push(...from)
}

// Bun keeps the first of two `@supports` blocks testing the same condition one right after the other and drops the second, and lowering nesting puts the blocks a rule holds one after the other, its declarations hoisted out from between; there too, of two rules with the same selector, it drops the first when it holds only custom properties, as Tailwind's `& { }` does.
// So each such block merges into the one before it, with only whitespace and comments between, or declarations too inside a rule, which stay where they are.
function merge(nodes: Node[], inRule: boolean): Node[] {
  const out: Node[] = []
  // The block a next one with its key merges into.
  let previous: { prelude: string, body: Node[] } | undefined

  for (const node of nodes) {
    if ('text' in node) {
      out.push(node)

      if (!inRule && node.text.replace(COMMENTS, '').trim() !== '')
        previous = undefined

      continue
    }

    const key = mergeKey(node, inRule)

    if (key !== undefined && previous !== undefined && mergeKey(previous, inRule) === key) {
      append(previous.body, node.body)

      continue
    }

    out.push(node)
    previous = key === undefined ? undefined : node
  }

  return out.map(node => 'text' in node ? node : { prelude: node.prelude, body: merge(node.body, inRule || !atRule(node)) })
}

function atRule(node: { prelude: string }): boolean {
  return node.prelude.replace(COMMENTS, '').trim().startsWith('@')
}

export interface StyleReferences {
  root: string
  files: string[]
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text()
  }
  catch {
    return undefined
  }
}

// Runs `load`, a plugin reading the stylesheet at `path` by itself, with the stylesheet starting with the references the extensions ask for.
async function referenced<T>(path: string, references: StyleReferences, load: () => Promise<T>): Promise<T> {
  const text = await readText(path)
  const given = text === undefined ? undefined : withReferences(text, path, references.root, references.files)

  return given === undefined || given === text ? load() : readingAs(path, given, load)
}

// The stylesheet build's plugins, each stylesheet one returns merged, and a last one merging those no plugin loads; `transform` runs on the parsed stylesheet first, as kay prunes a library's unused classes, so each output is parsed and printed once.
export function mergingSupports(plugins: BunPlugin[], transform: (nodes: Node[]) => Node[] | Promise<Node[]> = nodes => nodes, references?: StyleReferences): BunPlugin[] {
  const rewrite = async (css: string) => css.includes('{') ? print(merge(await transform(parse(css)), false)) : css
  const wrapped = plugins.map((plugin): BunPlugin => ({
    ...plugin,
    async setup(build) {
      const onLoad: PluginBuilder['onLoad'] = (constraints, callback) => build.onLoad(constraints, async (args) => {
        const result = await (references !== undefined && references.files.length > 0 && args.namespace === 'file' && referenceable(args.path, references.root) ? referenced(args.path, references, async () => callback(args)) : callback(args))

        return result && 'contents' in result && typeof result.contents === 'string' && (result.loader === 'css' || (result.loader === undefined && CSS_FILE.test(args.path))) ? { ...result, contents: await rewrite(result.contents) } : result
      })

      return plugin.setup(new Proxy(build, { get: (target, key) => key === 'onLoad' ? onLoad : Reflect.get(target, key) as unknown }))
    },
  }))
  const plain: BunPlugin = {
    name: 'kay-merge-supports',
    setup(build) {
      build.onLoad({ filter: CSS_FILE }, async ({ path }) => {
        const css = await Bun.file(path).text()
        const merged = await rewrite(css)

        return merged === css ? undefined : { contents: merged, loader: 'css' }
      })
    },
  }

  return [...wrapped, plain]
}
