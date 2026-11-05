import type { Diagnostic, KayFile } from './ast'
import type { Node, NodeOfType } from './estree'
import type { Path } from './scope'
import { buildProgram, templateExpressions } from './browser'
import { parseProgram } from './estree'
import { importedFromKay } from './rewrite'
import { walkScope } from './walk'

// What lives until its owner goes: a call with none, or one made when the owner is long done, is never stopped, and `onCleanup` drops its function.
const OWNED = new Set(['effect', 'watch', 'every', 'listen', 'debounced', 'onMount', 'onCleanup'])
// A function passed to these runs with an owner of its own.
const OWNING = new Set(['root'])
const LATER_CALLS = new Set(['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame', 'requestIdleCallback'])
const PROMISE_METHODS = new Set(['then', 'catch', 'finally'])
const WORD = /\b(?:effect|watch|every|listen|debounced|onMount|onCleanup)\b/

// `effect`, `watch`, `every`, `listen`, `debounced`, `onMount` and `onCleanup` called in a handler, a timer or a promise callback, or after an `await`: the component's owner is not there to stop them, so each call adds one that lives until the page goes.
export function unownedEffects(file: KayFile, serverNames: string[]): Diagnostic[] {
  const { source } = file
  const expressions = templateExpressions(file)
  const texts = [file.script ? source.slice(file.script.start, file.script.end) : '', ...expressions.map(expression => source.slice(expression.span.start, expression.span.end))]

  if (!texts.some(text => WORD.test(text)))
    return []

  const program = buildProgram(file, serverNames, expressions)
  const diagnostics: Diagnostic[] = []
  const awaits: { at: number, path: Path, fn: Node | undefined }[] = []
  const calls: { name: string, path: Path<NodeOfType<'CallExpression'>> }[] = []

  try {
    const walked = walkScope(parseProgram(program.code, { recover: true }).program, {
      AwaitExpression(path) {
        awaits.push({ at: path.node.start, path, fn: path.getFunctionParent()?.node })
      },
      ForOfStatement(path) {
        if (path.node.await)
          awaits.push({ at: path.node.start, path, fn: path.getFunctionParent()?.node })
      },
      CallExpression(path) {
        const name = importedFromKay(path.scope, path.node.callee)

        if (name !== undefined && OWNED.has(name))
          calls.push({ name, path })
      },
    })

    if (!walked)
      return []
  }
  catch {
    return []
  }

  for (const { name, path } of calls) {
    const fnPath = path.getFunctionParent()
    const fn = fnPath?.node
    const cause = fnPath && owning(fnPath) ? undefined : fnPath && handlerOf(fnPath, program.segments)
    const afterAwait = awaits.some(found => found.fn === fn && found.at < path.node.start && !elsewhere(found.path, path))
    const reason = cause ?? (afterAwait ? 'after an `await`, when the component\'s owner is gone' : undefined)

    if (reason === undefined)
      continue

    const callee = path.node.callee
    const start = toSource(program.segments, callee.start)
    const end = toSource(program.segments, callee.end)

    if (start === undefined || end === undefined)
      continue

    const result = name === 'onCleanup' ? 'its function is dropped and never runs' : 'nothing stops it, so each call adds one that lives until the page goes'

    diagnostics.push({ start, end, code: 'unowned-effect', checkOnly: true, message: `\`${name}\` called ${reason}: ${result}`, note: 'only a component\'s script, an effect or a `root` gives what is created in it an owner to stop it', help: 'call it in the component\'s script, or inside `root()` and call the `dispose` it hands over when done' })
  }

  return diagnostics
}

function toSource(segments: { generated: number, source: number, length: number }[], generated: number): number | undefined {
  const segment = segments.find(candidate => generated >= candidate.generated && generated <= candidate.generated + candidate.length)

  return segment && segment.source + generated - segment.generated
}

// Whether the function is the one a `root` or the like runs with an owner of its own.
function owning(fn: Path): boolean {
  const call = fn.parentPath?.node

  return call?.type === 'CallExpression' && call.arguments[0] === fn.node && call.callee.type === 'Identifier' && OWNING.has(call.callee.name)
}

// What the function is when it runs outside its component's setup: an event handler, the handler of a `listen`, a timer or a promise callback.
function handlerOf(fn: Path, segments: { generated: number, deferred?: boolean | undefined }[]): string | undefined {
  if (segments.some(segment => segment.deferred && segment.generated === fn.node.start))
    return 'in an event handler'

  const call = fn.parentPath?.node

  if (call?.type !== 'CallExpression' || !call.arguments.includes(fn.node as never))
    return undefined

  const callee = call.callee

  if (callee.type === 'Identifier') {
    if (LATER_CALLS.has(callee.name) && call.arguments[0] === fn.node)
      return 'in a timer'

    return importedFromKay(fn.scope, callee) === 'listen' && call.arguments[2] === fn.node ? 'in a `listen` handler, which runs on every event' : undefined
  }

  return callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && PROMISE_METHODS.has(callee.property.name) ? 'in a promise callback' : undefined
}

// An `await` in a branch the call is not in, such as the other side of an `if`: it does not come before the call.
function elsewhere(found: Path, call: Path): boolean {
  const within = (node: Node | null | undefined, inner: Node) => node != null && node.start <= inner.start && inner.end <= node.end

  return found.findParent((ancestor) => {
    const node = ancestor.node
    const at = found.node

    if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
      const side = [node.consequent, node.alternate].find(branch => within(branch, at))

      return side !== undefined && !within(side, call.node)
    }

    if (node.type === 'LogicalExpression')
      return within(node.right, at) && !within(node.right, call.node)

    return node.type === 'SwitchCase' && !within(node, call.node)
  }) !== null
}
