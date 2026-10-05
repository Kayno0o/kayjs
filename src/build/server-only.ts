import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import { basename, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { parse } from '@babel/parser'
import { loadTraverse } from '../compiler/rewrite'

// Globals a server has and a browser has not: reading one in a chunk the page loads throws as the chunk evaluates, before anything of it runs.
const SERVER_ONLY = new Set(['process', 'Bun'])
// Worth parsing a chunk for at all.
const MENTIONED = /\b(?:process|Bun)\b/

export interface ServerOnlyRead {
  name: string
  // The modules of the chunk whose own source reads it, which is where the fix goes.
  modules: string[]
}

// The server-only globals a built chunk reads where a browser would run it, each with the modules it came from.
// A read behind `typeof process` is how a module written for both sides asks, so it is left alone.
export function serverOnlyReads(code: string, modules: Map<string, string>): ServerOnlyRead[] {
  const names = readsIn(code)

  return [...names].map(name => ({ name, modules: [...modules].filter(([, source]) => readsIn(source).has(name)).map(([module]) => module) })).sort((a, b) => a.name.localeCompare(b.name))
}

function readsIn(code: string): Set<string> {
  const found = new Set<string>()

  if (!MENTIONED.test(code))
    return found

  let program: t.File

  try {
    program = parse(code, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: true, plugins: ['typescript', 'jsx'] })
  }
  catch {
    return found
  }

  loadTraverse()(program, {
    Identifier(path: NodePath<t.Identifier>) {
      const { name } = path.node

      if (!SERVER_ONLY.has(name) || !path.isReferencedIdentifier() || path.scope.hasBinding(name, { noGlobals: true }) || guarded(path, name))
        return

      found.add(name)
    },
  })

  return found
}

// Whether a `typeof` of the same name stands between the read and the statement holding it: the shape a module takes to run on either side.
function guarded(path: NodePath<t.Identifier>, name: string): boolean {
  if (path.parentPath?.isUnaryExpression() && path.parentPath.node.operator === 'typeof')
    return true

  let current: NodePath | null = path.parentPath

  while (current && !current.isStatement()) {
    if (asksTypeof(current.node, name))
      return true

    current = current.parentPath
  }

  return current !== null && asksTypeof(current.node, name)
}

function asksTypeof(node: t.Node, name: string): boolean {
  let asks = false

  loadTraverse()(node, {
    noScope: true,
    UnaryExpression(path: NodePath<t.UnaryExpression>) {
      if (path.node.operator === 'typeof' && path.node.argument.type === 'Identifier' && path.node.argument.name === name)
        asks = true
    },
  })

  return asks
}

// Refuses a client build whose chunks read a server-only global; `dir` is where the bundler wrote them, the metafile naming each as a path relative to it: such a chunk throws as the browser evaluates it, so every island in it stays dead.
export async function refuseServerOnlyReads(root: string, dir: string, outputs: Record<string, { inputs?: Record<string, unknown> }>): Promise<void> {
  const problems: string[] = []

  await Promise.all(Object.entries(outputs).map(async ([file, meta]) => {
    if (!file.endsWith('.js'))
      return

    const code = await sourceOf(resolve(dir, file))

    if (!MENTIONED.test(code))
      return

    // The metafile names a module relative to where the build ran, and the error names it relative to the project.
    const sources = new Map(await Promise.all(Object.keys(meta.inputs ?? {}).map(async (input) => {
      const path = resolve(process.cwd(), input)
      const name = path.startsWith(root + sep) ? relative(root, path) : input

      return [name, await sourceOf(path)] as const
    })))

    for (const { name, modules } of serverOnlyReads(code, sources))
      problems.push(`\`${name}\` in ${basename(file)}${modules.length > 0 ? `, read by ${modules.join(', ')}` : ''}`)
  }))

  if (problems.length > 0)
    throw new Error(`kay: a browser has no \`process\` or \`Bun\`, and these chunks a page loads read one, so every island in them dies as the chunk evaluates: ${problems.sort().join('; ')}. Keep the module reading it out of what an island imports, directly or through the page's script fence, and pass what it holds as a prop.`)
}

// A module of the chunk kay cannot read, a virtual one for instance, tells nothing about where the read came from.
async function sourceOf(file: string): Promise<string> {
  try {
    return await Bun.file(file).text()
  }
  catch {
    return ''
  }
}
