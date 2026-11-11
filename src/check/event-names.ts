import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { walk } from './ast'
import { scan } from './renamed-exports'

const NEEDLE = /kay-renew|kay:install|kay-dev-(?:built|types)|kai-chat-(?:open|send|draft)/
const GLOBALS = new Set(['window', 'globalThis', 'self'])

// A listener on the window for an event that moved to the document: the fix writes the new name where the handler reads no `detail`, as `kay-renew` and `kay:install` carry none.
const LISTENED: Record<string, { name: string, fix: boolean }> = {
  'kay-renew': { name: 'kay:renew', fix: true },
  'kay:install': { name: 'kay:install', fix: true },
  'kay-dev-built': { name: 'kay:dev-built', fix: false },
  'kay-dev-types': { name: 'kay:dev-types', fix: false },
}

// The chat's events an app dispatches on the window, their text `detail` a bare string before 1.99.
const DISPATCHED: Record<string, { name: string, text: boolean }> = {
  'kai-chat-open': { name: 'kai:chat-open', text: false },
  'kai-chat-send': { name: 'kai:chat-send', text: true },
  'kai-chat-draft': { name: 'kai:chat-draft', text: true },
}

type Call = Extract<Node, { type: 'CallExpression' }>

// The edit moving a call on the window, or on no object at all, to the document; null for any other receiver.
function toDocument(callee: Node, method: string, base: number): Edit | null {
  if (callee.type === 'Identifier')
    return callee.name === method ? { start: base + callee.start, end: base + callee.start, text: 'document.' } : null

  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier' || callee.property.name !== method)
    return null

  return callee.object.type === 'Identifier' && GLOBALS.has(callee.object.name) ? { start: base + callee.object.start, end: base + callee.object.end, text: 'document' } : null
}

const literal = (node: Node | undefined): string | undefined => node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined

// `addEventListener('kay-renew')` on the window and `dispatchEvent(new CustomEvent('kai-chat-send', ...))` on it, under the names before 1.99. The events are `<lib>:<verb>` on the document with an object `detail`, and the old ones still fire until 1.103.
// Found in the TypeScript files and script blocks of the project, on a literal name and the window or no object; a template's handler is not read. The fix is written only where nothing else changes for the app: a listener that reads no detail, a `kai:chat-open`, or a text `detail` written as `{ detail: text }`.
export async function eventNames(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-event-names', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-event-names', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        const call: Call = node
        const [first, second] = call.arguments

        const listened = LISTENED[literal(call.arguments[0]) ?? '']

        if (listened) {
          const move = toDocument(call.callee, 'addEventListener', base)

          if (move)
            report(base + call.start, base + call.end, `\`${literal(first)}\` on the window is deprecated since 1.99: the event is \`${listened.name}\` on the document, with an object \`detail\``, `listen to \`${listened.name}\` on the document`, listened.fix ? [move, { start: base + first!.start, end: base + first!.end, text: `${text[first!.start]}${listened.name}${text[first!.start]}` }] : null)

          return
        }

        const event = first?.type === 'NewExpression' && first.callee.type === 'Identifier' && (first.callee.name === 'CustomEvent' || first.callee.name === 'Event') ? first : undefined
        const sent = DISPATCHED[literal(event?.arguments[0]) ?? '']
        const move = sent && toDocument(call.callee, 'dispatchEvent', base)

        if (!event || !sent || !move || second !== undefined)
          return

        const name = event.arguments[0]!
        const option = event.arguments[1]
        const rename: Edit = { start: base + name.start, end: base + name.end, text: `${text[name.start]}${sent.name}${text[name.start]}` }
        const edits: Edit[] = [move, rename]
        let fixable = true

        if (sent.text) {
          const detail = option?.type === 'ObjectExpression' && option.properties.length === 1 ? option.properties[0] : undefined

          if (detail?.type === 'Property' && !detail.computed && !detail.shorthand && detail.key.type === 'Identifier' && detail.key.name === 'detail')
            edits.push({ start: base + detail.value.start, end: base + detail.value.end, text: `{ text: ${text.slice(detail.value.start, detail.value.end)} }` })
          else
            fixable = false
        }

        report(base + call.start, base + call.end, `\`${literal(name)}\` on the window is deprecated since 1.99: the event is \`${sent.name}\` on the document${sent.text ? ', its `detail` an object `{ text }`' : ''}`, `dispatch \`${sent.name}\` on the document`, fixable ? edits : null)
      })
    }
  })
}
