import type { Node, Span } from './ast'
import type { ImportBinding } from './script'
import { childBlocks } from './ast'

const WORD = /[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*/gu
const KEY_COLON = /^\s*:/
const TEXT_ATTRIBUTE = /\bwith\s*\{\s*type\s*:\s*(['"])text\1/

// Whether `name` at `at` is a project file imported as text, `import waves from './waves.svg' with { type: 'text' }`: markup the app made, as a written-out `innerHTML` is.
export function ownMarkupOf(src: string, template: readonly Node[], bindings: readonly ImportBinding[]): (name: string, at: number) => boolean {
  const own = new Set(bindings.filter(binding => !binding.typeOnly && binding.imported === 'default' && binding.source.startsWith('.') && !binding.source.split('/').includes('node_modules') && TEXT_ATTRIBUTE.test(src.slice(binding.declaration.start, binding.declaration.end))).map(binding => binding.local))

  if (own.size === 0)
    return () => false

  // A loop item, a snippet or slot parameter, an alias or a `const` of the template may take an import's name, and then holds any string within the span it is bound in.
  const shadows = new Map<string, Span[]>()
  const bound = (span: Span | undefined, scope: Span, destructured = false) => {
    if (span === undefined)
      return

    const text = src.slice(span.start, span.end)

    for (const match of text.matchAll(WORD)) {
      // The key of `{ key: name }` binds nothing.
      if (destructured && KEY_COLON.test(text.slice(match.index + match[0].length)))
        continue

      if (own.has(match[0]))
        shadows.set(match[0], [...shadows.get(match[0]) ?? [], scope])
    }
  }
  const scan = (nodes: readonly Node[]) => {
    for (const node of nodes) {
      if (node.kind === 'for') {
        // The item is not bound in the `else` block.
        const loop = { start: node.start, end: node.children.at(-1)?.end ?? node.start }

        bound(node.item, loop, true)
        bound(node.index, loop)
      }
      else if (node.kind === 'slot') {
        bound(node.params, node, true)
      }
      else if (node.kind === 'snippet') {
        bound(node.params, node)
      }
      else if (node.kind === 'await') {
        for (const branch of [node.resolved, node.rejected]) {
          if (branch)
            bound(branch.alias, branch, true)
        }
      }
      else if (node.kind === 'try') {
        if (node.rejected)
          bound(node.rejected.alias, node.rejected, true)
      }
      else if (node.kind === 'const') {
        // Seen by the lines after it at its indentation and by their children.
        bound(node.pattern, { start: node.start, end: nodes.at(-1)?.end ?? node.end }, true)
      }
      else if (node.kind === 'if') {
        for (const branch of node.branches)
          bound(branch.alias, branch, true)
      }

      for (const block of childBlocks(node))
        scan(block)
    }
  }

  scan(template)

  return (name, at) => own.has(name) && !shadows.get(name)?.some(span => at >= span.start && at < span.end)
}
