import type { CheckDiagnostic, CheckOptions } from '.'
import type { Edit } from './renamed-exports'
import { basename } from 'node:path'
import { lintLevel } from '../compiler/lints'
import { constBindings, exportedObject, keyName, objectOf } from '../compiler/object-literal'
import { featureProperties } from './config-objects'
import { renamedCallOptions } from './renamed-call-options'
import { scan } from './renamed-exports'

const GUARD = /\bguard\b|\brequireGuards\b/
const FROM_SERVER = (source: string) => source === 'kay/server' || source === '@kayjs/kay/server'

// `guard` in `vitals({ guard })`, in the `jobs` and `images` of kay.config.ts: `guards` since 1.105, the one name of a guard option; and `requireGuards`, `guards: { default }` since 1.105.
export async function guardOptions(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-guard-option', options.lints) === 'allow')
    return []

  const calls = await renamedCallOptions(root, options, { lint: 'deprecated-guard-option', needle: GUARD, from: FROM_SERVER, calls: { vitals: 0 }, renames: [['guard', 'guards']], since: '1.105', of: '`vitals()`' })

  const config = await scan(root, options, 'deprecated-guard-option', GUARD, ({ file, parsed, report }) => {
    if (basename(file) !== 'kay.config.ts')
      return

    for (const { ast, base } of parsed) {
      const bindings = constBindings(ast)
      const exported = exportedObject(ast, bindings)

      const own = (exported?.properties ?? []).filter((one): one is Extract<typeof one, { type: 'Property' }> => one.type === 'Property')
      const required = own.find(one => keyName(one) === 'requireGuards')

      if (required) {
        const { value } = required
        const taken = own.some(one => keyName(one) === 'guards')
        const known = value.type === 'Literal' && typeof value.value === 'boolean'
        const edits: Edit[] | null = taken || !known || required.shorthand || required.computed ? null : [{ start: base + required.start, end: base + required.end, text: `guards: { default: '${value.value ? 'closed' : 'open'}' }` }]

        report(base + required.start, base + required.end, '`requireGuards` is deprecated since 1.105: `guards: { default }` says what a route no guard covers comes to', 'write `guards: { default: \'closed\' }` for `true` and `\'open\'` for `false`', edits)
      }

      const features = exported === undefined ? [] : [...featureProperties(exported, bindings, 'ops', 'jobs').map(feature => ({ name: 'jobs', feature })), ...featureProperties(exported, bindings, 'assets', 'images').map(feature => ({ name: 'images', feature }))]

      for (const { name, feature } of features) {
        const section = objectOf(feature.value, bindings)
        const properties = (section?.properties ?? []).filter((one): one is Extract<typeof one, { type: 'Property' }> => one.type === 'Property')
        const old = properties.find(one => keyName(one) === 'guard')

        if (!old)
          continue

        const edits: Edit[] | null = properties.some(one => keyName(one) === 'guards') || old.computed ? null : [old.shorthand ? { start: base + old.start, end: base + old.end, text: 'guards: guard' } : { start: base + old.key.start, end: base + old.key.end, text: 'guards' }]

        report(base + old.start, base + old.end, `\`guard\` of \`${name}\` is deprecated since 1.105: the option is \`guards\``, 'write `guards`', edits)
      }
    }
  })

  return [...calls, ...config]
}
