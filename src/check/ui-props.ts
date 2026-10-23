import type { CheckDiagnostic, CheckOptions } from '.'
import type { Attribute } from '../compiler/ast'
import { findProjectFiles } from '../build/files'
import { elementsIn } from '../compiler/ast'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { analyzeScript, analyzeServer } from '../compiler/script'

const KAY_ONLY = /\.kay$/

// A prop of a kayjs-ui component renamed since 1.70: the component's file under `@kaynooo/kayjs-ui/`, the old and the new name, the minor that renamed it, and why the new one is the one the other components use.
// `fix` is how far the rename is safe: `rename` always, `bare-arrow` only for a handler written `() => ...`, which ignores the argument the new prop passes, and `none` for a prop whose calls changed, where the lint only reports.
const RENAMES: readonly Rename[] = [
  { lint: 'deprecated-ui-prop', component: 'select.kay', from: 'loading', to: 'busy', since: '1.70', fix: 'rename', because: 'a control waiting on work is `busy` across kayjs-ui' },
  { lint: 'deprecated-ui-callback', component: 'confirm-delete.kay', from: 'onOpen', to: 'onOpenChange', since: '1.72', fix: 'none', because: 'an open state is reported by `onOpenChange(open)` across kayjs-ui, which also tells when it closes: write `onOpenChange={open => open && ...}` to keep running on opening only' },
  { lint: 'deprecated-ui-callback', component: 'split-layout.kay', from: 'onSidebarClose', to: 'onSidebarOpenChange', since: '1.72', fix: 'bare-arrow', because: 'an open state is reported by `onOpenChange(open)` across kayjs-ui, here with `false` when the back button closes the sidebar' },
]

interface Rename {
  lint: 'deprecated-ui-prop' | 'deprecated-ui-callback'
  component: string
  from: string
  to: string
  since: string
  fix: 'rename' | 'bare-arrow' | 'none'
  because: string
}

const BARE_ARROW = /^\(\s*\)\s*=>/

// The props kayjs-ui components took under their old names before the minor that renamed them, as a tag writes them.
// A tag is found through the default import of the component's file from the library; a tag spreading its props, or a component imported under a path of its own, is not read.
export async function renamedUiProps(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const active = RENAMES.filter(rename => lintLevel(rename.lint, options.lints) !== 'allow')

  if (active.length === 0)
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, KAY_ONLY, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes('@kaynooo/kayjs-ui/') || !active.some(rename => source.includes(rename.from)))
      continue

    const parsed = parseKay(source)
    const levelAt = lintLevels(source, options.lints)
    const tags = new Map<string, Rename[]>()

    for (const binding of [...analyzeScript(source, parsed.script, [], [], parsed.module).imports, ...analyzeServer(source, parsed.server)?.imports ?? []]) {
      const renames = binding.imported === 'default' ? active.filter(candidate => binding.source === `@kaynooo/kayjs-ui/${candidate.component}`) : []

      if (renames.length > 0)
        tags.set(binding.local, renames)
    }

    for (const element of elementsIn(parsed.template)) {
      const renames = element.component ? tags.get(element.name) : undefined

      if (!renames)
        continue

      const named = (name: string) => element.attributes.filter((attribute): attribute is Exclude<Attribute, { kind: 'spread' }> => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === name)

      for (const { rename, attribute } of renames.flatMap(rename => named(rename.from).map(attribute => ({ rename, attribute })))) {
        const here = levelAt(rename.lint, attribute.name.start)

        if (here === 'allow')
          continue

        const taken = named(rename.to).length > 0
        const safe = rename.fix === 'rename' || (rename.fix === 'bare-arrow' && attribute.kind === 'expression' && !attribute.shorthand && BARE_ARROW.test(source.slice(attribute.expression.start, attribute.expression.end)))
        const text = attribute.kind === 'expression' && attribute.shorthand ? { ...attribute.shorthand, text: `${rename.to}={${rename.from}}` } : { ...attribute.name, text: rename.to }

        found.push({
          file,
          ...positionAt(source, attribute.name.start),
          end: attribute.name.end,
          message: `\`${rename.from}\` of \`${element.name}\` is \`${rename.to}\` since ${rename.since}, as ${rename.because}`,
          help: `write \`${rename.to}\` for \`${rename.from}\`${rename.fix !== 'none' ? '' : ', which also reports closing: read its `open` argument'}`,
          code: rename.lint,
          severity: here === 'warn' ? 'warning' : 'error',
          ...!taken && safe && { fixes: [{ title: `Use ${rename.to}`, edits: [{ start: text.start, end: text.end, text: text.text }], safe: true }] },
        })
      }
    }
  }

  return found
}
