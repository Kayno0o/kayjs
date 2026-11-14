import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import type { Edit, Found } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { DURATION_TEXT } from '../runtime/duration'
import { importsOf, walk } from './ast'
import { renamedCallOptions } from './renamed-call-options'
import { scan } from './renamed-exports'

const FROM_SERVER = (source: string) => source === 'kay/server' || source === '@kayjs/kay/server'
const JOBS = /\b(?:queue|workflow|schedule|background)\b/
const UNDERSCORE = /(?<![\w$])_(?:input)?(?![\w$])/
const SCHEDULE = /\bschedule\b/
const LOST_AFTER = /\blostAfter\b/
const DISK_FILES = /\bdiskFiles\b/
const COMMENT = /\/[*/]/
const SIGNAL_NAME = /signal|abort/i
const JOB_CALLS = ['queue', 'workflow', 'schedule', 'background'] as const

type CallNode = NodeOfType<'CallExpression'>
type FunctionNode = NodeOfType<'ArrowFunctionExpression'> | NodeOfType<'FunctionExpression'>
type Param = FunctionNode['params'][number]

const isFunction = (node: Node | undefined): node is FunctionNode => node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'

// The job function a call of `queue`, `workflow`, `schedule` or `background` from `kay/server` is: its name, as it was imported or read off `import * as`.
function jobCall(ast: Parameters<typeof importsOf>[0]): (callee: Node) => (typeof JOB_CALLS)[number] | undefined {
  const bound = JOB_CALLS.map(name => ({ name, ...importsOf(ast, FROM_SERVER, name) })).filter(call => call.locals.size > 0 || call.namespaces.size > 0)

  return callee => bound.find(call => callee.type === 'Identifier'
    ? call.locals.has(callee.name)
    : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && call.namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === call.name)?.name
}

// Whether a parameter is a plain name, with no default, no `?` and no annotation but `AbortSignal` when `signal` allows it.
function plainName(param: Param | undefined, signal = false): param is NodeOfType<'Identifier'> {
  if (param?.type !== 'Identifier' || param.optional)
    return false

  const annotation = param.typeAnnotation?.typeAnnotation

  if (annotation === undefined)
    return true

  return signal && annotation.type === 'TSTypeReference' && annotation.typeName.type === 'Identifier' && annotation.typeName.name === 'AbortSignal' && annotation.typeArguments == null
}

// Whether a parameter reads as the signal of the old shape: named like one, or annotated `AbortSignal`, and not a context.
function signalLike(param: NodeOfType<'Identifier'>): boolean {
  const annotation = param.typeAnnotation?.typeAnnotation

  if (annotation == null)
    return SIGNAL_NAME.test(param.name)

  return annotation.type === 'TSTypeReference' && annotation.typeName.type === 'Identifier' && annotation.typeName.name === 'AbortSignal'
}

const binding = (name: string, key: string) => name === key ? key : `${key}: ${name}`

// The handlers a call of one of the four hands over, where the handler is: a queue's or workflow's second argument, a background job's first, a schedule's jobs, the second argument, a list of them or the values of a table.
function handlersOf(call: CallNode, name: (typeof JOB_CALLS)[number]): FunctionNode[] {
  const args = call.arguments

  if (name === 'queue' || name === 'workflow')
    return isFunction(args[1]) ? [args[1]] : []

  if (name === 'background')
    return isFunction(args[0]) ? [args[0]] : []

  const listed = (node: Node | undefined): FunctionNode[] => {
    if (isFunction(node))
      return [node]

    return node?.type === 'ArrayExpression' ? node.elements.filter((element): element is FunctionNode => isFunction(element ?? undefined)) : []
  }

  const [first] = args

  if (first?.type === 'ObjectExpression' && !first.properties.some(property => property.type === 'Property' && ['every', 'cron'].includes(keyName(property) ?? '')))
    return first.properties.flatMap(property => property.type === 'Property' ? listed(property.value) : [])

  return listed(args[1])
}

// The edits giving a queue handler `(payload, { signal, job })` for `(payload, signal, job)`, null where the parameters are not plain names.
function queueEdits(fn: FunctionNode, base: number): Edit[] | null | undefined {
  const [, signal, job] = fn.params

  if (signal === undefined || signal.type !== 'Identifier' || (fn.params.length < 3 && !signalLike(signal)))
    return undefined

  if (fn.params.length > 3 || !plainName(signal, true) || (job !== undefined && !plainName(job)))
    return null

  const text = `{ ${[binding(signal.name, 'signal'), ...job === undefined ? [] : [binding((job as NodeOfType<'Identifier'>).name, 'job')]].join(', ')} }`

  return [{ start: base + signal.start, end: base + (job ?? signal).end, text }]
}

// The edits giving a workflow `(input, { step, job: { id } })` for `({ id, input, step })`.
function workflowEdits(fn: FunctionNode, base: number): Edit[] | null | undefined {
  const [run] = fn.params

  if (run?.type !== 'ObjectPattern' || fn.params.length > 1)
    return undefined

  const keys = run.properties.map(property => property.type === 'Property' ? keyName(property) : undefined)

  if (!keys.some(key => key === 'step' || key === 'input'))
    return undefined

  if (run.typeAnnotation != null || run.properties.some((property, at) => property.type !== 'Property' || property.computed || !['id', 'input', 'step'].includes(keys[at]!) || property.value.type !== 'Identifier'))
    return null

  const names = new Map(run.properties.map(property => [keyName(property as NodeOfType<'Property'>)!, (property as NodeOfType<'Property'> & { value: NodeOfType<'Identifier'> }).value.name]))
  const context = [...names.has('step') ? [binding(names.get('step')!, 'step')] : [], ...names.has('id') ? [`job: { ${binding(names.get('id')!, 'id')} }`] : []]

  return [{ start: base + run.start, end: base + run.end, text: `${names.get('input') ?? '_input'}${context.length === 0 ? '' : `, { ${context.join(', ')} }`}` }]
}

// The edits giving a scheduled or background job `(_, { signal })` for `(signal)`.
function signalEdits(fn: FunctionNode, base: number, source: string): Edit[] | null | undefined {
  const [signal] = fn.params

  if (fn.params.length !== 1 || signal?.type !== 'Identifier' || !signalLike(signal))
    return undefined

  if (!plainName(signal, true))
    return null

  // An arrow function written `signal => ...` needs the parentheses two parameters take.
  const text = `_, { ${binding(signal.name, 'signal')} }`
  const bare = source.slice(0, base + signal.start).trimEnd().at(-1) !== '('

  return [{ start: base + signal.start, end: base + signal.end, text: bare ? `(${text})` : text }]
}

function editsOf(fn: FunctionNode, name: (typeof JOB_CALLS)[number], base: number, source: string): Edit[] | null | undefined {
  if (name === 'queue')
    return queueEdits(fn, base)

  const edits = name === 'workflow' ? workflowEdits(fn, base) : signalEdits(fn, base, source)

  // The fix adds an unused parameter named `_` or `_input`, which would shadow one the body reads.
  return edits && UNDERSCORE.test(source.slice(base + fn.body!.start, base + fn.body!.end)) ? null : edits
}

// The options written after a first argument, as the properties of the new object or, for any other expression, spread into it.
function spreadOf(source: string, base: number, options: Node | undefined): string[] {
  if (options === undefined)
    return []

  if (options.type === 'ObjectExpression')
    return options.properties.map(property => source.slice(base + property.start, base + property.end))

  return [`...${source.slice(base + options.start, base + options.end)}`]
}

// A handler written before 1.105, which gets its signal and its job as arguments of their own: `queue(name, (payload, signal, job) => ...)`, `workflow(name, ({ id, input, step }) => ...)`, `schedule(when, (signal) => ...)` and `background((signal) => ...)`.
// Every job handler is `(input, ctx)` since 1.105, with `ctx.signal`, `ctx.job`, `ctx.log`, `ctx.locale` and a workflow's `ctx.step`. Found on a handler written inline in the call, where its parameters are plain names; the fix destructures them off the context, so the body reads them under the names it used. A queue handler written in the old shape still runs, as its second argument is the signal; a workflow's, a schedule's and a background job's does not.
export async function jobHandlers(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-job-handler', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-job-handler', JOBS, ({ source, parsed, report }) => {
    for (const { ast, base } of parsed) {
      const named = jobCall(ast)

      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        const name = named(node.callee)

        if (name === undefined)
          return

        for (const fn of handlersOf(node, name)) {
          const edits = editsOf(fn, name, base, source)

          if (edits === undefined)
            continue

          // A comment in a range the fix replaces would be lost with it.
          const lost = edits?.some(edit => COMMENT.test(source.slice(edit.start, edit.end)))

          report(base + fn.params[0]!.start, base + fn.params.at(-1)!.end, `the handler of \`${name}()\` is \`(input, ctx)\` since 1.105: its signal and job are read off \`ctx\``, 'take `ctx` and read `signal`, `job`, `log` and `locale` off it', lost ? null : edits)
        }
      })
    }
  })
}

// `schedule(when, job, options)`, `schedule({ cron | every, ...options }, job)` since 1.105: one shape, the schedule and its options in one object, as `queue` and `workflow` keep theirs in one.
// Found on a call of `schedule` from `kay/server` whose first argument is a string or number literal; the fix writes `every` for a length and `cron` for the rest, and spreads the options after it.
export async function scheduleCalls(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-schedule-call', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-schedule-call', SCHEDULE, ({ source, parsed, report }) => {
    for (const { ast, base } of parsed) {
      const named = jobCall(ast)

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || named(node.callee) !== 'schedule')
          return

        const [when, job, rest] = node.arguments

        if (when?.type !== 'Literal' || (typeof when.value !== 'string' && typeof when.value !== 'number') || job === undefined || node.arguments.length > 3 || node.arguments.some(argument => argument.type === 'SpreadElement'))
          return

        const key = typeof when.value === 'number' || DURATION_TEXT.test(when.value) ? 'every' : 'cron'
        const spread = spreadOf(source, base, rest)

        const edits: Edit[] = [{ start: base + when.start, end: base + when.end, text: `{ ${[`${key}: ${source.slice(base + when.start, base + when.end)}`, ...spread].join(', ')} }` }]

        if (rest !== undefined)
          edits.push({ start: base + job.end, end: base + rest.end, text: '' })

        const lost = rest !== undefined && COMMENT.test(source.slice(base + job.end, base + rest.end))

        report(base + when.start, base + when.end, '`schedule(when, job, options)` is deprecated since 1.105: the schedule and its options are one object', `write \`schedule({ ${key}: ... }, job)\``, lost ? null : edits)
      })
    }
  })
}

// `lostAfter` in the options of `queue()` or `workflow()`, `timeout` since 1.105: the one name of a job's time limit, as a schedule's.
export async function jobOptions(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return renamedCallOptions(root, options, { lint: 'deprecated-job-options', needle: LOST_AFTER, from: FROM_SERVER, calls: { queue: 2, workflow: 2 }, renames: [['lostAfter', 'timeout']], since: '1.105', of: '`queue()` and `workflow()`' })
}

// `diskFiles(dir, hooks)`, `diskFiles({ dir, ...hooks })` since 1.105: the options of every file store are one object, as `s3Files({ ...settings, ...hooks })` and `memoryFiles({ ...hooks })` take them.
export async function diskFilesCalls(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-disk-files', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-disk-files', DISK_FILES, ({ source, parsed, report }: Found) => {
    for (const { ast, base } of parsed) {
      const { locals, namespaces } = importsOf(ast, FROM_SERVER, 'diskFiles')

      if (locals.size === 0 && namespaces.size === 0)
        continue

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.arguments.length === 0 || node.arguments.length > 2 || node.arguments.some(argument => argument.type === 'SpreadElement'))
          return

        const { callee } = node
        const isDisk = callee.type === 'Identifier'
          ? locals.has(callee.name)
          : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'diskFiles'
        const [dir, hooks] = node.arguments

        // A string is the old form; an object, or any other expression that may hold one, is the new.
        const oldForm = node.arguments.length === 2 || dir!.type === 'TemplateLiteral' || (dir!.type === 'Literal' && typeof dir!.value === 'string')

        if (!isDisk || !oldForm)
          return

        const spread = spreadOf(source, base, hooks)

        const last = hooks ?? dir!
        const text = `{ ${[`dir: ${source.slice(base + dir!.start, base + dir!.end)}`, ...spread].join(', ')} }`
        const lost = COMMENT.test(source.slice(base + dir!.start, base + last.end))

        report(base + dir!.start, base + last.end, '`diskFiles(dir, hooks)` is deprecated since 1.105: the options of a file store are one object', 'write `diskFiles({ dir, ...hooks })`', lost ? null : [{ start: base + dir!.start, end: base + last.end, text }])
      })
    }
  })
}
