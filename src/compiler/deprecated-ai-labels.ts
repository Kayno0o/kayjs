import type { Details, ElementNode, Span } from './ast'
import type { Named } from './deprecated-ui-props'

// The keys of `labels` a `Chat` takes, as its messages (`ai.chat.<key>`) are keyed.
const CHAT_KEYS = ['field', 'started', 'send', 'stop', 'retry', 'thinking', 'error', 'sources', 'stopped', 'table', 'reasoning', 'running', 'done', 'failed', 'arguments', 'result', 'approval', 'allow', 'deny', 'allowed', 'denied', 'new', 'attach', 'remove', 'attachRefused', 'attachTooBig', 'attachFull', 'regenerate', 'edit', 'save', 'cancel', 'editEmpty', 'editBusy', 'record', 'transcribing', 'unheard', 'transcribeFailed', 'conversations', 'untitled', 'rename', 'delete', 'deleteConfirm', 'conflict', 'loadFailed', 'changeFailed', 'signedOut']
const LAUNCHER_KEYS = ['open', 'close', 'expand', 'collapse']

const IDENTIFIER = /^[A-Z_$][\w$]*$/i
const WHITESPACE = /\s/

// The two keys whose flat prop was named for what it said rather than for its message.
const RENAMED: Record<string, string> = { waitingLabel: 'thinking', failureLabel: 'error' }

// The flat props of each component, by the library's file, and the key of `labels` each is.
const FLAT: Record<string, ReadonlyMap<string, string>> = {
  'ai/chat': flat(CHAT_KEYS),
  'ai/chat-launcher': flat([...CHAT_KEYS, ...LAUNCHER_KEYS]),
  'ai/chat-panel': flat(['open', 'close', 'new', 'expand', 'collapse']),
}

function flat(keys: readonly string[]): ReadonlyMap<string, string> {
  const props = new Map(keys.map(key => [`${key}Label`, key]))

  for (const [prop, key] of Object.entries(RENAMED)) {
    if (props.delete(`${key}Label`))
      props.set(prop, key)
  }

  return props
}

type Report = (span: Span, message: string, details: Details) => void

// The `<key>Label` props of a kayjs-ai chat component, `labels={{ key: ... }}` since 1.105: one object keyed as the messages are, in place of up to 45 props that each held one text. Found on a component bound to the library's file; the fix writes the first of them as `labels` holding every one, and offers none beside a `labels` already written or a bare `sendLabel` with no value.
export function deprecatedAiLabels(element: ElementNode, file: string, text: (span: Span) => string, report: Report): void {
  const props = FLAT[file]

  if (props === undefined)
    return

  const attributes = element.attributes.filter((attribute): attribute is Named => attribute.kind !== 'spread')
  const old = attributes.filter(attribute => props.has(text(attribute.name)))
  const first = old[0]

  if (first === undefined)
    return

  const written = attributes.some(attribute => text(attribute.name) === 'labels')
  const entries = old.map((attribute) => {
    const key = props.get(text(attribute.name))!
    const name = IDENTIFIER.test(key) ? key : JSON.stringify(key)

    if (attribute.kind === 'static')
      return { attribute, entry: `${name}: ${JSON.stringify(attribute.text)}`, end: attribute.value.end + 1 }

    if (attribute.kind === 'expression') {
      return attribute.shorthand
        ? { attribute, entry: `${name}: ${text(attribute.name)}`, end: attribute.shorthand.end }
        : { attribute, entry: `${name}: ${text(attribute.expression).trim()}`, end: attribute.expression.end + 1 }
    }

    return undefined
  })
  const found = entries.filter(one => one !== undefined)
  const message = `The \`<key>Label\` props of \`${element.name}\` are one \`labels\` object since 1.105, keyed as its messages are: \`labels={{ send: ... }}\``

  if (written || found.length < entries.length)
    report(first.name, message, { help: 'Move each into `labels`' })
  else
    report(first.name, message, { help: 'Write `labels`', fixes: [{ title: 'Write `labels`', safe: true, edits: edits(found, text) }] })
}

// The first prop becomes `labels={{ ... }}` and each other one goes, with the blank before it.
function edits(entries: { attribute: Named, entry: string, end: number }[], text: (span: Span) => string): { start: number, end: number, text: string }[] {
  const [first, ...rest] = entries
  const object = `labels={{ ${entries.map(({ entry }) => entry).join(', ')} }}`

  return [
    { start: start(first!.attribute), end: first!.end, text: object },
    ...rest.map(({ attribute, end }) => ({ start: blank(attribute, text), end, text: '' })),
  ]
}

function start(attribute: Named): number {
  return attribute.kind === 'expression' && attribute.shorthand ? attribute.shorthand.start : attribute.name.start
}

// Where the blank before an attribute begins, found in the text of its own line so a removal leaves the others as they were.
function blank(attribute: Named, text: (span: Span) => string): number {
  const at = start(attribute)
  let from = at

  while (from > 0 && WHITESPACE.test(text({ start: from - 1, end: from })))
    from--

  return from
}
