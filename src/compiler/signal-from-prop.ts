import type { Diagnostic, Fix } from './ast'
import type { Node, NodeOfType } from './estree'
import type { ParsedFence, PropsDeclaration } from './script'
import { eachNode } from './each-node'
import { INITIAL_PROP } from './live-reads'
import { patternNames } from './pattern-names'

type ImportSpecifier = NodeOfType<'ImportSpecifier'>

const KAY = 'kay'

// The name a prop is read by, through a chain of plain properties (`todo.title`), or undefined for any other expression.
function propRoot(node: Node): string | undefined {
  if (node.type === 'Identifier')
    return node.name

  return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' ? propRoot(node.object) : undefined
}

function importedAs(node: Node, name: string): node is ImportSpecifier {
  return node.type === 'ImportSpecifier' && node.importKind !== 'type' && node.local.name === name && (node.imported.type === 'Identifier' ? node.imported.name : node.imported.value) === name
}

// The names an `effect` writes, `effect(() => shown = open)` or `shown.set(open)`: a signal it follows needs no `linked`.
function followedByEffects(ast: Node): Set<string> {
  const names = new Set<string>()

  eachNode(ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'effect')
      return

    eachNode(node, (inner) => {
      if (inner.type === 'AssignmentExpression' && inner.left.type === 'Identifier')
        names.add(inner.left.name)

      if (inner.type === 'CallExpression' && inner.callee.type === 'MemberExpression' && inner.callee.property.type === 'Identifier' && inner.callee.property.name === 'set' && inner.callee.object.type === 'Identifier')
        names.add(inner.callee.object.name)
    })

    return false
  })

  return names
}

// A `signal(prop)` at the top of an island's script: the signal takes the prop's value when the component is created, so it keeps the first one when the page gives the island another, as a refresh does while the island stays. `linked(() => prop)` is the signal that follows its source and can still be written.
// A prop named as a seed (`initial...`, `default...`) is meant to be read once, and a name declared again in the script is left alone.
export function signalFromProps(fence: ParsedFence, props: PropsDeclaration | undefined): Diagnostic[] {
  if (!props || !fence.code.includes('signal'))
    return []

  const watched = new Set(props.bindings.filter(binding => !INITIAL_PROP.test(binding.key)).map(binding => fence.code.slice(binding.local.start - fence.offset, binding.local.end - fence.offset)))
  const declaration = fence.ast.body.find(node => node.type === 'ImportDeclaration' && node.source.value === KAY && node.importKind !== 'type')
  const specifier = declaration?.type === 'ImportDeclaration' ? declaration.specifiers.find(node => importedAs(node, 'signal')) : undefined

  if (watched.size === 0 || specifier?.type !== 'ImportSpecifier')
    return []

  const linked = declaration?.type === 'ImportDeclaration' && declaration.specifiers.some(node => importedAs(node, 'linked'))
  let others = 0
  let taken = false
  const seeds: { call: NodeOfType<'CallExpression'>, name: string | undefined }[] = []

  eachNode(fence.ast, (node) => {
    if (node.type === 'ImportDeclaration' || (node.type === 'VariableDeclaration' && fence.shift(node).start === props.statement.start))
      return false

    if (node.type === 'VariableDeclarator') {
      for (const name of patternNames(node.id)) {
        watched.delete(name)
        taken ||= name === 'linked'
      }

      const { init } = node

      if (init?.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'signal' && init.arguments.length === 1 && init.arguments[0]!.type !== 'SpreadElement')
        seeds.push({ call: init, name: node.id.type === 'Identifier' ? node.id.name : undefined })
    }

    if (node.type === 'Identifier' && node.name === 'signal')
      others++

    return true
  })

  const diagnostics: Diagnostic[] = []
  const followed = followedByEffects(fence.ast)

  for (const { call, name } of seeds) {
    if (name !== undefined && followed.has(name))
      continue

    const seed = call.arguments[0]!
    const root = propRoot(seed)

    if (root === undefined || !watched.has(root))
      continue

    const text = fence.code.slice(seed.start, seed.end)
    const imports: Fix['edits'] = linked || taken ? [] : [{ ...fence.shift(specifier), text: others > 1 ? 'linked, signal' : 'linked' }]
    const fix: Fix = { title: `Write \`linked(() => ${text})\``, safe: !taken, edits: [{ ...fence.shift(call), text: `linked(() => ${text})` }, ...imports] }

    diagnostics.push({
      ...fence.shift(call),
      code: 'signal-from-prop',
      message: `\`signal(${text})\` keeps the first value of \`${root}\`, as a signal made from a prop does not follow it`,
      note: 'the island stays when the page gives it new props, as after an action or a refresh, so a seed read once shows the old value',
      help: `write \`linked(() => ${text})\`, which follows the prop and can still be written, or \`// kay-allow signal-from-prop\` when the first value is meant`,
      checkOnly: true,
      fixes: taken ? [] : [fix],
    })
  }

  return diagnostics
}
