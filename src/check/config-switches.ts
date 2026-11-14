import type { CheckDiagnostic, CheckOptions } from '.'
import type { Edit } from './renamed-exports'
import { basename } from 'node:path'
import { lintLevel } from '../compiler/lints'
import { constBindings, exportedObject, keyName } from '../compiler/object-literal'
import { scan } from './renamed-exports'

const PROXY = /\bproxy\b/

// `proxy: 2` in kay.config.ts, `proxy: { hops: 2 }` since 1.105 and `proxy: true` for one: every feature key takes `false`, `true` or its bag, and a number was a third form of the same switch.
export async function configSwitches(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-config-switch', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-config-switch', PROXY, ({ file, parsed, report }) => {
    if (basename(file) !== 'kay.config.ts')
      return

    for (const { ast, base } of parsed) {
      const exported = exportedObject(ast, constBindings(ast))

      for (const property of exported?.properties ?? []) {
        if (property.type !== 'Property' || keyName(property) !== 'proxy' || property.computed || property.shorthand)
          continue

        const { value } = property

        if (value.type !== 'Literal' || typeof value.value !== 'number')
          continue

        const text = value.value === 1 ? 'true' : `{ hops: ${value.raw} }`
        const edits: Edit[] = Number.isInteger(value.value) && value.value >= 1 ? [{ start: base + value.start, end: base + value.end, text }] : []

        report(base + value.start, base + value.end, `\`proxy: ${value.raw}\` is deprecated since 1.105: a feature key is \`false\`, \`true\` or its options, and the number of proxies is \`hops\``, 'write `true` for one proxy and `{ hops: n }` for more', edits)
      }
    }
  })
}
