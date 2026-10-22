import type { CheckDiagnostic, CheckOptions } from '.'
import type { Attribute } from '../compiler/ast'
import { findProjectFiles } from '../build/files'
import { elementsIn } from '../compiler/ast'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { analyzeScript, analyzeServer } from '../compiler/script'

const KAY_ONLY = /\.kay$/

// A prop of a kayjs-ui component renamed in 1.70: the component's file under `@kaynooo/kayjs-ui/`, the old and the new name, and why the new one is the one the other components use.
const RENAMES = [
  { component: 'select.kay', from: 'loading', to: 'busy', because: 'a control waiting on work is `busy` across kayjs-ui' },
] as const

// The props kayjs-ui components took under their old names before 1.70, as a tag writes them.
// A tag is found through the default import of the component's file from the library; a tag spreading its props, or a component imported under a path of its own, is not read.
export async function renamedUiProps(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-ui-prop', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, KAY_ONLY, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes('@kaynooo/kayjs-ui/') || !RENAMES.some(rename => source.includes(rename.from)))
      continue

    const parsed = parseKay(source)
    const levelAt = lintLevels(source, options.lints)
    const tags = new Map<string, (typeof RENAMES)[number]>()

    for (const binding of [...analyzeScript(source, parsed.script).imports, ...analyzeServer(source, parsed.server)?.imports ?? []]) {
      const rename = binding.imported === 'default' ? RENAMES.find(candidate => binding.source === `@kaynooo/kayjs-ui/${candidate.component}`) : undefined

      if (rename)
        tags.set(binding.local, rename)
    }

    for (const element of elementsIn(parsed.template)) {
      const rename = element.component ? tags.get(element.name) : undefined

      if (!rename)
        continue

      const named = (name: string) => element.attributes.filter((attribute): attribute is Exclude<Attribute, { kind: 'spread' }> => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === name)

      for (const attribute of named(rename.from)) {
        const here = levelAt('deprecated-ui-prop', attribute.name.start)

        if (here === 'allow')
          continue

        const taken = named(rename.to).length > 0
        const text = attribute.kind === 'expression' && attribute.shorthand ? { ...attribute.shorthand, text: `${rename.to}={${rename.from}}` } : { ...attribute.name, text: rename.to }

        found.push({
          file,
          ...positionAt(source, attribute.name.start),
          end: attribute.name.end,
          message: `\`${rename.from}\` of \`${element.name}\` is \`${rename.to}\` since 1.70, as ${rename.because}`,
          help: `write \`${rename.to}\` for \`${rename.from}\``,
          code: 'deprecated-ui-prop',
          severity: here === 'warn' ? 'warning' : 'error',
          ...!taken && { fixes: [{ title: `Use ${rename.to}`, edits: [{ start: text.start, end: text.end, text: text.text }], safe: true }] },
        })
      }
    }
  }

  return found
}
