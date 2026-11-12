import type { Diagnostic } from './ast'
import type { Node, NodeOfType } from './estree'
import type { Lint } from './lints'
import type { ParsedFence, ServerAnalysis } from './script'
import { eachNode } from './each-node'

// The lint of the `performance` group that reads a server fence, with the other lints in `LINTS`.
export const SERIAL_AWAITS_LINTS = {
  'serial-awaits': {
    level: 'warn',
    group: 'performance',
    summary: 'Two or more consecutive top-level `const x = await ...` statements of a `--- server` fence where no awaited expression reads a name an earlier one of the run declares: each waits for the one before, so the page takes the sum of their times and a click waits as long. The fix writes them as `const [a, b] = await Promise.all([...])`. A pattern, a type annotation, `let`, a `try`, any statement or comment between two awaits and an expression reading an earlier binding end the run and are left alone. The fix is a suggestion, not a safe one, so `kay check --fix` leaves it: it starts the awaits together, so a guard (`await requireUser()`, anything that redirects or throws) must stay in its own statement before them.',
    wrong: '--- server\nconst posts = await loadPosts()\nconst tags = await loadTags()\n---\np {posts.length} {tags.length}',
    right: '--- server\nconst [posts, tags] = await Promise.all([\n  loadPosts(),\n  loadTags(),\n])\n---\np {posts.length} {tags.length}',
  },
} as const satisfies Record<string, Lint>

type Declaration = NodeOfType<'VariableDeclaration'>
type Awaited = NodeOfType<'AwaitExpression'>

interface Step {
  statement: Declaration
  name: string
  awaited: Awaited
}

// A `const name = await expression` statement of one plain declarator, the only shape the lint groups: a pattern, a type annotation, a `let` or any wrapper around the `await` is left alone.
function stepOf(statement: Node): Step | undefined {
  if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const' || statement.declarations.length !== 1)
    return undefined

  const declaration = statement.declarations[0]!
  const { id, init } = declaration

  if (id.type !== 'Identifier' || id.typeAnnotation || !init || init.type !== 'AwaitExpression')
    return undefined

  return { statement, name: id.name, awaited: init }
}

// Every name an expression mentions, a property or a key too: it over-approximates on purpose, so a group is only broken more often.
function namesIn(node: Node): Set<string> {
  const names = new Set<string>()

  eachNode(node, (inner) => {
    if (inner.type === 'Identifier')
      names.add(inner.name)
  })

  return names
}

// Two or more consecutive top-level `const x = await ...` statements of a fence, none reading a binding an earlier one of the run declares: each waits for the one before it, where `Promise.all` starts them together. The fix writes the run as one destructuring of `Promise.all`.
// Anything between two awaits (a statement, a comment) ends the run, as it may depend on or act before the next one.
export function serialAwaits(server: ServerAnalysis | undefined): Diagnostic[] {
  const fence = server?.fence

  if (fence === undefined || !fence.code.includes('await'))
    return []

  const diagnostics: Diagnostic[] = []
  const { body } = fence.ast
  let run: Step[] = []

  const flush = () => {
    if (run.length >= 2)
      diagnostics.push(report(fence, run))

    run = []
  }

  for (const [index, statement] of body.entries()) {
    const step = stepOf(statement)
    const previous = body[index - 1]
    const commented = previous !== undefined && fence.comments.some(comment => comment.start >= previous.end && comment.end <= statement.start)

    if (!step || commented) {
      flush()
    }

    if (!step)
      continue

    const taken = new Set(run.map(earlier => earlier.name))
    const reads = namesIn(step.awaited.argument)

    if ([...taken].some(name => reads.has(name)))
      flush()

    run.push(step)
  }

  flush()

  return diagnostics
}

function report(fence: ParsedFence, run: Step[]): Diagnostic {
  const first = run[0]!.statement
  const last = run.at(-1)!.statement
  const names = run.map(step => step.name)
  // A sequence loses the parentheses the parser drops, which would split it into array elements.
  const values = run.map((step) => {
    const { argument } = step.awaited
    const text = fence.code.slice(argument.start, argument.end)

    return `  ${argument.type === 'SequenceExpression' ? `(${text})` : text},`
  })
  const text = `const [${names.join(', ')}] = await Promise.all([\n${values.join('\n')}\n])`
  const span = fence.shift({ start: first.start, end: last.end })

  return {
    ...span,
    code: 'serial-awaits',
    message: `${names.map(name => `\`${name}\``).join(', ')} are awaited one after the other, though none reads another`,
    note: 'each `await` waits for the one before it, so the page takes the sum of their times where `Promise.all` takes the longest',
    help: 'write them as one `await Promise.all([...])`, keeping a guard (`await requireUser()`, anything that redirects or throws) in its own statement before it, or start the ones the first paint does not need unawaited and read them in an `await` block',
    // Starting the awaits together changes behaviour when one of them is a guard, so `kay check --fix` leaves it to the person.
    fixes: [{ title: 'Run them together with Promise.all', edits: [{ ...span, text }], safe: false }],
  }
}
