import type { Diagnostic, KayFile, Span } from './ast'
import type { ScriptAnalysis } from './script-shared'
import { templateFacts } from './ast'

const SEPARATOR = /[,;]/
const AFTER_COMMA = /^\s*,\s*/
const BEFORE_COMMA = /,\s*$/
const SNIPPET_WORD = /\bSnippet\b/g
const SNIPPET_ONLY = /^import\s+(?:type\s*)?\{\s*(?:type\s+)?Snippet\s*(?:,\s*)?\}/

// What leaves the props type: the member and the separator after it, or the one before the last member, or the whole type when it is the only one.
function removal(own: Span, previous: Span | undefined, next: Span | undefined, type: Span | undefined): { start: number, end: number, text: string } {
  if (next)
    return { start: own.start, end: next.start, text: '' }

  return previous ? { start: previous.end, end: own.end, text: '' } : { ...type ?? own, text: '{}' }
}

// The `Snippet` import the removed member leaves unused, when the member was its only use: the whole line, or its specifier.
function unusedSnippet(source: string, script: ScriptAnalysis): { start: number, end: number, text: string }[] {
  const binding = script.imports.find(({ local, source: from }) => local === 'Snippet' && from === 'kay')

  if (!binding || source.match(SNIPPET_WORD)!.length > 2)
    return []

  const line = source.slice(binding.declaration.start, binding.declaration.end)

  if (SNIPPET_ONLY.test(line)) {
    const end = source[binding.declaration.end] === '\n' ? binding.declaration.end + 1 : binding.declaration.end

    return [{ start: binding.declaration.start, end: source[end] === '\n' ? end + 1 : end, text: '' }]
  }

  const after = AFTER_COMMA.exec(source.slice(binding.span.end))

  if (after)
    return [{ start: binding.span.start, end: binding.span.end + after[0].length, text: '' }]

  const before = BEFORE_COMMA.exec(source.slice(0, binding.span.start))

  return before ? [{ start: binding.span.start - before[0].length, end: binding.span.end, text: '' }] : []
}

// A component taking `children?: Snippet` beside a bare `slot`, which the template says already: the props type declares the children only to require them (`children: Snippet`) or to type what a block gets.
// The fix drops the member, when nothing reads `children` as a prop.
export function deprecatedChildrenProp(file: KayFile, script: ScriptAnalysis): Diagnostic[] {
  const props = script.props
  const member = props?.children

  if (!props || !member || props.name || props.rest || props.bindings.some(binding => binding.key === 'children') || !templateFacts(file).childrenSlot)
    return []

  // A member's span takes its separator along.
  const bare = (span: Span) => ({ start: span.start, end: span.end - (SEPARATOR.test(file.source[span.end - 1] ?? '') ? 1 : 0) })
  const own = bare(member.span)
  const edits = [removal(own, member.previous && bare(member.previous), member.next, props.type), ...unusedSnippet(file.source, script)]

  return [{
    ...own,
    code: 'deprecated-children-prop',
    checkOnly: true,
    message: '`children?: Snippet` is declared by the template since 1.105: a `slot` takes children with no declaration',
    help: 'remove it from the props type; write `children: Snippet` to require them',
    fixes: [{ title: 'Remove `children`', safe: true, edits }],
  }]
}
