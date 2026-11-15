import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const NEEDLE = /\bmaxAge\b/
const FROM_SERVER = (source: string) => source === 'kay/server' || source === '@kayjs/kay/server'
// The calls whose options hold how long something lives, with the position of the options.
const CALLS: Record<string, { method: string, argument: number }> = { signed: { method: 'sign', argument: 2 }, files: { method: 'url', argument: 1 } }
// The functions taking the options as an argument, with its position: kay's `workChallenge(scope, options)` and kayjs-auth's `proofOfWork(options)`.
const FUNCTIONS: { name: string, from: (source: string) => boolean, argument: number }[] = [
  { name: 'workChallenge', from: FROM_SERVER, argument: 1 },
  { name: 'proofOfWork', from: source => source === '@kayjs/auth', argument: 0 },
]
const FROM_KAY = (source: string) => source === 'kay' || source === '@kayjs/kay'
// The option bags of `protect` that hold how long a challenge or a stamp stays good.
const BAGS = new Set(['proofOfWork', 'minTime'])

type Property = Extract<NodeOfType<'ObjectExpression'>['properties'][number], { type: 'Property' }>
type Report = (start: number, end: number, message: string, help: string, edits: { start: number, end: number, text: string }[] | null) => void

interface Bound {
  base: number
  report: Report
  actions: Set<string>
  actionNamespaces: Set<string>
  methods: { method: string, argument: number, locals: Set<string> }[]
  functions: { name: string, argument: number, locals: Set<string> }[]
  fromAuth: boolean
}

// Reports the `maxAge` key of `object`, which says how long `of` lives; one beside a `ttl`, or a computed key, is reported with no fix.
function reportIn(bound: Bound, object: NodeOfType<'ObjectExpression'>, of: string): void {
  const properties = object.properties.filter((property): property is Property => property.type === 'Property')
  const old = properties.find(property => keyName(property) === 'maxAge')

  if (old === undefined)
    return

  const { base } = bound
  const fixable = !old.computed && !properties.some(property => keyName(property) === 'ttl')
  const edits = fixable ? [old.shorthand ? { start: base + old.start, end: base + old.end, text: 'ttl: maxAge' } : { start: base + old.key.start, end: base + old.key.end, text: 'ttl' }] : null

  bound.report(base + old.start, base + old.end, `\`maxAge\` of ${of} is deprecated since 1.105: how long it lives is \`ttl\`, as \`maxAge\` is kept for an HTTP header or a cookie`, 'write `ttl`', edits)
}

// `signed.sign(...)` and `files.url(...)`, the methods of an imported object.
function reportMethod(bound: Bound, node: NodeOfType<'CallExpression'>): void {
  if (node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.object.type !== 'Identifier' || node.callee.property.type !== 'Identifier')
    return

  const { name } = node.callee.object
  const property = node.callee.property.name
  const call = bound.methods.find(one => one.locals.has(name) && one.method === property)
  const written = call === undefined ? undefined : node.arguments[call.argument]

  if (written?.type === 'ObjectExpression')
    reportIn(bound, written, `\`${name}.${property}()\``)
}

// `workChallenge(...)` and `proofOfWork(...)`, imported functions.
function reportFunction(bound: Bound, node: NodeOfType<'CallExpression'>): void {
  if (node.callee.type !== 'Identifier')
    return

  const { name } = node.callee
  const found = bound.functions.find(one => one.locals.has(name))
  const written = found === undefined ? undefined : node.arguments[found.argument]

  if (written?.type === 'ObjectExpression')
    reportIn(bound, written, `\`${found!.name}()\``)
}

// `data.maxAge.link` and `data.maxAge.code` in a template of kayjs-auth's mails.
function reportMailRead(bound: Bound, node: NodeOfType<'MemberExpression'>): void {
  if (!bound.fromAuth || node.computed || node.property.type !== 'Identifier' || (node.property.name !== 'link' && node.property.name !== 'code'))
    return

  const { object } = node

  if (object.type !== 'MemberExpression' || object.computed || object.property.type !== 'Identifier' || object.property.name !== 'maxAge')
    return

  const { property } = object

  bound.report(bound.base + property.start, bound.base + property.end, '`maxAge` of a mail\'s data is deprecated since 1.105: how long its link and code work is `ttl`', 'write `ttl`', [{ start: bound.base + property.start, end: bound.base + property.end, text: 'ttl' }])
}

// The `proofOfWork` and `minTime` bags of an action's `protect`.
function reportAction(bound: Bound, node: NodeOfType<'CallExpression'>): void {
  const called = node.callee.type === 'Identifier' ? bound.actions.has(node.callee.name) : node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier' && bound.actionNamespaces.has(node.callee.object.name) && node.callee.property.type === 'Identifier' && node.callee.property.name === 'action'

  if (!called)
    return

  for (const argument of node.arguments) {
    const protect = argument.type === 'ObjectExpression' ? argument.properties.find((property): property is Property => property.type === 'Property' && !property.computed && keyName(property) === 'protect') : undefined

    if (protect?.value.type !== 'ObjectExpression')
      continue

    for (const bag of protect.value.properties) {
      if (bag.type === 'Property' && !bag.computed && BAGS.has(keyName(bag) ?? '') && bag.value.type === 'ObjectExpression')
        reportIn(bound, bag.value, `\`${keyName(bag)!}\``)
    }
  }
}

// `maxAge` where it says how long something lives and no HTTP header or cookie is meant: `signed.sign(use, value, { maxAge })`, `files.url(key, { maxAge })`, `workChallenge(scope, { maxAge })`, kayjs-auth's `proofOfWork({ maxAge })`, the `proofOfWork` and `minTime` of an action's `protect` and the `maxAge.link` and `maxAge.code` of a kayjs-auth mail's data, `ttl` since 1.105, as `ttl` is the one word for how long data lives.
// The fix renames the key; one beside a `ttl`, or a computed key, is reported with no fix.
export async function ttlNames(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-ttl-names', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-ttl-names', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const actions = importsOf(ast, FROM_KAY, 'action')
      const bound: Bound = {
        base,
        report,
        actions: actions.locals,
        actionNamespaces: actions.namespaces,
        methods: Object.entries(CALLS).map(([name, call]) => ({ ...call, locals: importsOf(ast, FROM_SERVER, name).locals })),
        functions: FUNCTIONS.map(one => ({ ...one, locals: importsOf(ast, one.from, one.name).locals })),
        fromAuth: ast.body.some(statement => statement.type === 'ImportDeclaration' && statement.source.value === '@kayjs/auth'),
      }

      walk(ast, (node: Node) => {
        if (node.type === 'CallExpression') {
          reportMethod(bound, node)
          reportFunction(bound, node)
          reportAction(bound, node)
        }
        else if (node.type === 'MemberExpression') {
          reportMailRead(bound, node)
        }
      })
    }
  })
}
