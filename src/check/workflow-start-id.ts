import type { CheckDiagnostic, CheckOptions } from '.'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const WORKFLOW = /\bworkflow\b/
const START = /\.start\b/
const FROM_KAY = (source: string) => source === 'kay' || source === 'kay/server'
const HELP = 'write `key`'

// The names the project binds to a `workflow()` call imported from `kay` or `kay/server`, as `const onboarding = workflow(...)`.
async function workflowNames(root: string, options: CheckOptions): Promise<Set<string>> {
  const names = new Set<string>()

  await scan(root, options, 'deprecated-workflow-start-id', WORKFLOW, ({ parsed }) => {
    for (const { ast } of parsed) {
      const { locals, namespaces } = importsOf(ast, FROM_KAY, 'workflow')

      walk(ast, (node) => {
        if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || node.init?.type !== 'CallExpression')
          return

        const { callee } = node.init

        if ((callee.type === 'Identifier' && locals.has(callee.name)) || (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'workflow'))
          names.add(node.id.name)
      })
    }
  })

  return names
}

// `id` in the options of a workflow's `start()`, `key` since 1.98, the name `enqueue()` gives the same caller-chosen identity.
// Found on `name.start(input, { id })` where `name` is bound to a `workflow()` call anywhere in the project; `{ id }` becomes `key: id`, and an object that already holds a `key` is reported with no fix.
export async function workflowStartId(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-workflow-start-id', options.lints) === 'allow')
    return []

  const names = await workflowNames(root, options)

  if (names.size === 0)
    return []

  return scan(root, options, 'deprecated-workflow-start-id', START, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.property.type !== 'Identifier' || node.callee.property.name !== 'start' || node.callee.object.type !== 'Identifier' || !names.has(node.callee.object.name))
          return

        const argument = node.arguments[1]

        if (argument?.type !== 'ObjectExpression')
          return

        const id = argument.properties.find((property): property is Extract<typeof property, { type: 'Property' }> => property.type === 'Property' && keyName(property) === 'id')

        if (!id)
          return

        const taken = argument.properties.some(property => property.type === 'Property' && keyName(property) === 'key')
        const renamed = id.shorthand ? { start: base + id.start, end: base + id.end, text: 'key: id' } : { start: base + id.key.start, end: base + id.key.end, text: 'key' }

        report(base + id.start, base + id.end, '`id` in the options of a workflow\'s `start()` is deprecated since 1.98: the caller-chosen identity is `key`, as in `enqueue()`', HELP, taken || id.computed ? null : [renamed])
      })
    }
  })
}
