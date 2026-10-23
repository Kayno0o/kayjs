import type { CheckDiagnostic, CheckOptions } from '.'
import type { Attribute } from '../compiler/ast'
import { findProjectFiles } from '../build/files'
import { elementsIn } from '../compiler/ast'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { analyzeScript, analyzeServer } from '../compiler/script'

const KAY_ONLY = /\.kay$/
const SIMPLE = /^[\w$.]+$/

interface Rename {
  lint: 'deprecated-ui-prop' | 'deprecated-ui-callback'
  // The component's file under `@kaynooo/kayjs-ui/`.
  component: string
  from: string
  to: string
  // The minor that renamed it.
  since: string
  // How far the rename is safe: `rename` always, `bare-arrow` only for a handler written `() => ...`, which ignores the argument the new prop passes, and `none` for a prop whose calls changed, where the lint only reports.
  fix: 'rename' | 'bare-arrow' | 'none'
  because: string
  // For a boolean replaced by one value of an enum: the value it stands for, and the one a false stands for.
  value?: { on: string, off: string }
}

const BARE_ARROW = /^\(\s*\)\s*=>/

// A prop of a kayjs-ui component under its old name, or a boolean now a value of an enum prop.
const RENAMES: readonly Rename[] = [
  { lint: 'deprecated-ui-prop', component: 'select.kay', from: 'loading', to: 'busy', since: '1.70', fix: 'rename', because: 'a control waiting on work is `busy` across kayjs-ui' },
  { lint: 'deprecated-ui-prop', component: 'badge.kay', from: 'stamp', to: 'variant', since: '1.72', fix: 'rename', because: 'a look is a `variant` across kayjs-ui', value: { on: 'stamp', off: 'outline' } },
  { lint: 'deprecated-ui-prop', component: 'badge.kay', from: 'solid', to: 'variant', since: '1.72', fix: 'rename', because: 'a look is a `variant` across kayjs-ui', value: { on: 'solid', off: 'outline' } },
  { lint: 'deprecated-ui-prop', component: 'form-field.kay', from: 'compact', to: 'size', since: '1.72', fix: 'rename', because: 'a step of size is a `size` across kayjs-ui', value: { on: 'sm', off: 'md' } },
  { lint: 'deprecated-ui-prop', component: 'file-drop.kay', from: 'compact', to: 'size', since: '1.72', fix: 'rename', because: 'a step of size is a `size` across kayjs-ui', value: { on: 'sm', off: 'md' } },
  { lint: 'deprecated-ui-prop', component: 'notice.kay', from: 'compact', to: 'size', since: '1.72', fix: 'rename', because: 'a step of size is a `size` across kayjs-ui', value: { on: 'sm', off: 'md' } },
  { lint: 'deprecated-ui-prop', component: 'qr-code.kay', from: 'size', to: 'pixels', since: '1.72', fix: 'rename', because: '`size` is a step from `xs` to `lg` in the other components, and the width of a code is in pixels' },
  { lint: 'deprecated-ui-callback', component: 'confirm-delete.kay', from: 'onOpen', to: 'onOpenChange', since: '1.72', fix: 'none', because: 'an open state is reported by `onOpenChange(open)` across kayjs-ui, which also tells when it closes: write `onOpenChange={open => open && ...}` to keep running on opening only' },
  { lint: 'deprecated-ui-callback', component: 'split-layout.kay', from: 'onSidebarClose', to: 'onSidebarOpenChange', since: '1.72', fix: 'bare-arrow', because: 'an open state is reported by `onOpenChange(open)` across kayjs-ui, here with `false` when the back button closes the sidebar' },
]

// The props kayjs-ui components took under their old names, as a tag writes them.
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

        // The new name is given, or another old prop of the tag becomes it too (`stamp solid`), so no one edit says both.
        const taken = named(rename.to).length > 0 || renames.some(other => other !== rename && other.to === rename.to && named(other.from).length > 0)
        const safe = rename.fix === 'rename' || (rename.fix === 'bare-arrow' && attribute.kind === 'expression' && !attribute.shorthand && BARE_ARROW.test(source.slice(attribute.expression.start, attribute.expression.end)))
        const edit = safe ? rewrite(source, attribute, rename) : undefined

        found.push({
          file,
          ...positionAt(source, attribute.name.start),
          end: attribute.name.end,
          message: `\`${rename.from}\` of \`${element.name}\` is \`${rename.to}\`${rename.value ? ' with a value' : ''} since ${rename.since}, as ${rename.because}`,
          help: rename.value ? `write \`${rename.to}="${rename.value.on}"\` for \`${rename.from}\`` : `write \`${rename.to}\` for \`${rename.from}\`${rename.fix !== 'none' ? '' : ', which also reports closing: read its \`open\` argument'}`,
          code: rename.lint,
          severity: here === 'warn' ? 'warning' : 'error',
          ...!taken && edit && { fixes: [{ title: `Use ${rename.to}`, edits: [edit], safe: true }] },
        })
      }
    }
  }

  return found
}

// The edit writing an attribute the new way, or nothing for a form it cannot rewrite safely: a static string for a boolean.
function rewrite(source: string, attribute: Exclude<Attribute, { kind: 'spread' }>, rename: Rename): { start: number, end: number, text: string } | undefined {
  if (!rename.value) {
    const text = attribute.kind === 'expression' && attribute.shorthand ? { ...attribute.shorthand, text: `${rename.to}={${rename.from}}` } : { ...attribute.name, text: rename.to }

    return { start: text.start, end: text.end, text: text.text }
  }

  const { on, off } = rename.value

  if (attribute.kind === 'boolean')
    return { start: attribute.name.start, end: attribute.name.end, text: `${rename.to}="${on}"` }

  if (attribute.kind !== 'expression')
    return undefined

  const written = attribute.shorthand ? source.slice(attribute.name.start, attribute.name.end) : source.slice(attribute.expression.start, attribute.expression.end).trim()
  const test = SIMPLE.test(written) ? written : `(${written})`

  const start = attribute.shorthand?.start ?? attribute.name.start
  const end = attribute.shorthand?.end ?? source.indexOf('}', attribute.expression.end) + 1

  return { start, end, text: `${rename.to}={${test} ? '${on}' : '${off}'}` }
}
