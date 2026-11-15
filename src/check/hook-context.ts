import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { configObjects, isProperty, propertiesOf } from './config-objects'
import { scan } from './renamed-exports'

type ObjectExpression = NodeOfType<'ObjectExpression'>

const NEEDLE = /\bctx\b/
const HOOKS = ['beforeRun', 'onSuccess', 'onError']
const FROM_KAY = (source: string): boolean => source === 'kay' || source === 'kay/server'

type Hook = NodeOfType<'ArrowFunctionExpression'> | NodeOfType<'FunctionExpression'>

// The `ctx` an action hook reads off its event, `context` since 1.105: the one field every hook event carries, which holds the action's own context besides who asks.
// A hook is the function written under `beforeRun`, `onSuccess` or `onError` in the `actions` of the config or the options of an `action()` call; the fix renames what a destructured parameter or a member read of the event names, and offers none where the name is given a default or the event is used another way.
function hookEdits(hook: Hook, base: number): { start: number, end: number, edits: Edit[] | null }[] {
  const [event] = hook.params
  const found: { start: number, end: number, edits: Edit[] | null }[] = []

  if (event?.type === 'ObjectPattern') {
    for (const property of event.properties) {
      if (property.type !== 'Property' || property.computed || keyName(property) !== 'ctx')
        continue

      const value = property.value
      const renamed = property.shorthand ? { start: base + property.start, end: base + property.end, text: 'context: ctx' } : { start: base + property.key.start, end: base + property.key.end, text: 'context' }
      const edits: Edit[] | null = property.shorthand && value.type !== 'Identifier' ? null : [renamed]

      found.push({ start: base + property.start, end: base + property.end, edits })
    }

    return found
  }

  if (event?.type !== 'Identifier' || hook.body === null || hook.body === undefined)
    return found

  walk(hook.body, (node) => {
    if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === event.name && node.property.type === 'Identifier' && node.property.name === 'ctx')
      found.push({ start: base + node.property.start, end: base + node.property.end, edits: [{ start: base + node.property.start, end: base + node.property.end, text: 'context' }] })
  })

  return found
}

const isHook = (node: Node): node is Hook => node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression'

// The hook functions an object of action hooks holds.
function hooksOf(object: ObjectExpression): Hook[] {
  return HOOKS.flatMap(name => propertiesOf(object, name)).flatMap(property => isProperty(property) && isHook(property.value) ? [property.value] : [])
}

export async function hookContext(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-hook-context', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-hook-context', NEEDLE, ({ file, parsed, report }) => {
    for (const { ast, base } of parsed) {
      const objects: ObjectExpression[] = []

      for (const { object } of configObjects(file, ast)) {
        const [actions] = propertiesOf(object, 'actions')

        if (actions?.value.type === 'ObjectExpression')
          objects.push(actions.value)
      }

      const { locals, namespaces } = importsOf(ast, FROM_KAY, 'action')

      if (locals.size > 0 || namespaces.size > 0) {
        walk(ast, (node) => {
          if (node.type !== 'CallExpression')
            return

          const callee = node.callee
          const called = callee.type === 'Identifier' ? locals.has(callee.name) : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'action'
          const last = node.arguments.at(-1)

          if (called && last?.type === 'ObjectExpression')
            objects.push(last)
        })
      }

      for (const hook of objects.flatMap(hooksOf)) {
        for (const { start, end, edits } of hookEdits(hook, base))
          report(start, end, '`ctx` of an action hook\'s event is deprecated since 1.105: every hook event carries one `context`, which holds the action\'s own context beside who asks', 'read `context`', edits)
      }
    }
  })
}
