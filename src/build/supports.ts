import type { BunPlugin, PluginBuilder } from 'bun'

const CSS_FILE = /\.css$/
const SUPPORTS_PRELUDE = /^@supports\b/i
const SPACES = /\s+/g
const COMMENTS = /\/\*[\s\S]*?\*\//g
const LAST_MEANINGFUL = /\S\s*$/
// An unquoted `url(`, whose contents may hold any brace or semicolon.
const URL_OPEN = /^url\([^'"\s]/i

type Node = { text: string } | { prelude: string, body: Node[] }

// The stylesheet as text runs and blocks, each block its prelude (what leads to its `{`, the whitespace and comments before included) and what it holds; strings, comments and `url()` are read past whole, so a brace in one is not one.
function parse(css: string): Node[] {
  let at = 0
  const read = (): Node[] => {
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

        const body = read()

        nodes.push({ prelude, body })
        start = at
        statement = at
      }
      else if (char === '}') {
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

  return read()
}

function print(nodes: Node[]): string {
  return nodes.map(node => 'text' in node ? node.text : `${node.prelude}{${print(node.body)}}`).join('')
}

// What a block merges by, written one way: the condition of an `@supports` block, or inside a rule the selector of a nested rule; undefined for any other block.
function mergeKey(node: Node, inRule: boolean): string | undefined {
  if ('text' in node)
    return undefined

  const prelude = node.prelude.replace(COMMENTS, '').trim().replace(SPACES, ' ')

  if (SUPPORTS_PRELUDE.test(prelude))
    return prelude.toLowerCase()

  return inRule && !prelude.startsWith('@') ? prelude : undefined
}

// Puts what `from` holds at the end of `into`, a `;` between when `into` ends on a declaration that has none.
function append(into: Node[], from: Node[]): void {
  const last = LAST_MEANINGFUL.exec(print(into).replace(COMMENTS, ''))?.[0].trim()

  if (last !== undefined && last !== ';' && last !== '}' && last !== '{')
    into.push({ text: ';' })

  into.push(...from)
}

// Bun keeps the first of two `@supports` blocks testing the same condition one right after the other and drops the second, and lowering nesting puts the blocks a rule holds one after the other, its declarations hoisted out from between; there too, of two rules with the same selector, it drops the first when it holds only custom properties, as Tailwind's `& { }` does.
// So each such block merges into the one before it, with only whitespace and comments between, or declarations too inside a rule.
function merge(nodes: Node[], inRule: boolean): Node[] {
  const out: Node[] = []
  // The block a next one testing its condition merges into, and the length of `out` right after it.
  let previous: { block: { prelude: string, body: Node[] }, at: number } | undefined

  for (const node of nodes) {
    if ('text' in node) {
      out.push(node)

      if (!inRule && node.text.replace(COMMENTS, '').trim() !== '')
        previous = undefined

      continue
    }

    const key = mergeKey(node, inRule)

    if (key !== undefined && previous !== undefined && mergeKey(previous.block, inRule) === key) {
      append(previous.block.body, node.body)
      // What came between is whitespace and comments, which go with it, or declarations, which stay.
      out.splice(previous.at, Infinity, ...out.slice(previous.at).filter(between => inRule && 'text' in between))
      previous.at = out.length

      continue
    }

    out.push(node)
    previous = key === undefined ? undefined : { block: node, at: out.length }
  }

  return out.map(node => 'text' in node ? node : { prelude: node.prelude, body: merge(node.body, inRule || !atRule(node)) })
}

function atRule(node: { prelude: string }): boolean {
  return node.prelude.replace(COMMENTS, '').trim().startsWith('@')
}

// The stylesheet with every block Bun would drop merged into one it keeps.
export function mergeSupports(css: string): string {
  return css.includes('{') ? print(merge(parse(css), false)) : css
}

// The stylesheet build's plugins, each stylesheet one returns merged, and a last one merging those no plugin loads.
export function mergingSupports(plugins: BunPlugin[]): BunPlugin[] {
  const wrapped = plugins.map((plugin): BunPlugin => ({
    ...plugin,
    async setup(build) {
      const onLoad: PluginBuilder['onLoad'] = (constraints, callback) => build.onLoad(constraints, async (args) => {
        const result = await (callback)(args)

        return result && 'contents' in result && typeof result.contents === 'string' && (result.loader === 'css' || (result.loader === undefined && CSS_FILE.test(args.path))) ? { ...result, contents: mergeSupports(result.contents) } : result
      })

      return plugin.setup(new Proxy(build, { get: (target, key) => key === 'onLoad' ? onLoad : Reflect.get(target, key) as unknown }))
    },
  }))
  const plain: BunPlugin = {
    name: 'kay-merge-supports',
    setup(build) {
      build.onLoad({ filter: CSS_FILE }, async ({ path }) => {
        const css = await Bun.file(path).text()
        const merged = mergeSupports(css)

        return merged === css ? undefined : { contents: merged, loader: 'css' }
      })
    },
  }

  return [...wrapped, plain]
}
