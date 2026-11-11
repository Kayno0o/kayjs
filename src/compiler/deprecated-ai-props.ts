import type { Details, ElementNode, Span } from './ast'
import type { Named } from './deprecated-ui-props'
import { rename } from './deprecated-ui-props'

// The kayjs-ai components whose `reasoning` is `showReasoning` and `thinkingLabel` is `waitingLabel` since 1.99.
const CHATS = new Set(['ai/chat', 'ai/chat-launcher'])

const RENAMES: readonly (readonly [string, string, string])[] = [
  ['reasoning', 'showReasoning', '`reasoning` named both how much a model thinks (`effort` of `ask()`) and whether Chat shows what it thought, so the show-or-hide switch says what it shows'],
  ['thinkingLabel', 'waitingLabel', '`thinkingLabel` is what Chat says while it waits for the first words, beside `reasoningLabel` which names the thinking it folds, so it says what it waits for'],
]

// The kayjs-ai Chat props an app still writes under the name they had before 1.99, found on a component bound to the library's file.
export function deprecatedAiProps(element: ElementNode, file: string, text: (span: Span) => string, report: (span: Span, message: string, details: Details) => void): void {
  if (!CHATS.has(file))
    return

  const attributes = element.attributes.filter((attribute): attribute is Named => attribute.kind !== 'spread')
  const attributeNamed = (name: string) => attributes.find(attribute => text(attribute.name) === name)

  for (const [old, current, why] of RENAMES) {
    const attribute = attributeNamed(old)

    if (attribute)
      report(attribute.name, `\`${old}\` on \`${element.name}\` is \`${current}\` since 1.99: ${why}`, attributeNamed(current) ? { help: `Drop \`${old}\`, \`${current}\` is there` } : { help: `Write \`${current}\``, fixes: [{ title: `Write \`${current}\``, edits: [rename(attribute, old, current)], safe: true }] })
  }
}
