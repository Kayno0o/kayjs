import type { CheckDiagnostic, CheckOptions } from '.'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { configObjects, propertyOf } from './config-objects'
import { scan } from './renamed-exports'

const NEEDLE = /\b(?:defaultLocale|prefixDefault|domains)\b/

// The keys `defaultLocale`, `prefixDefault` and `domains` of `i18n` in the config, which are `default` and `mode` since 1.105: `mode: 'always'` for `prefixDefault: true`, `mode: { domains }` for `domains`.
// The fix renames or rewrites one key where the object is written in place and `default` and `mode` are not yet there, and offers none for `domains` together with `prefixDefault`, a `prefixDefault` that is no literal, or a key written as a method or a getter.
export async function i18nKeys(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-i18n-keys', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-i18n-keys', NEEDLE, ({ file, parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      for (const { object, call } of configObjects(file, ast)) {
        const i18n = call === undefined ? propertyOf(object, 'i18n') : undefined
        const group = i18n?.value.type === 'ObjectExpression' ? i18n.value : undefined

        if (group === undefined)
          continue

        const plain = group.properties.flatMap(property => property.type === 'Property' && !property.computed && !property.method && property.kind === 'init' ? [property] : [])
        const named = (name: string) => plain.find(property => property.key.type === 'Identifier' ? property.key.name === name : property.key.type === 'Literal' && property.key.value === name)
        const [defaultLocale, prefixDefault, domains] = [named('defaultLocale'), named('prefixDefault'), named('domains')]
        const spread = group.properties.some(property => property.type !== 'Property')

        if (defaultLocale !== undefined) {
          const edits: Edit[] | null = spread || named('default') !== undefined ? null : [defaultLocale.shorthand ? { start: base + defaultLocale.start, end: base + defaultLocale.end, text: 'default: defaultLocale' } : { start: base + defaultLocale.key.start, end: base + defaultLocale.key.end, text: 'default' }]

          report(base + defaultLocale.start, base + defaultLocale.end, '`i18n.defaultLocale` is `i18n.default` since 1.105', 'write `default`', edits)
        }

        if (prefixDefault !== undefined) {
          const { value } = prefixDefault
          const free = !spread && named('mode') === undefined && domains === undefined && value.type === 'Literal' && value.value === true

          report(base + prefixDefault.start, base + prefixDefault.end, '`i18n.prefixDefault` is `i18n.mode: \'always\'` since 1.105', 'write `mode: \'always\'`', free && !prefixDefault.shorthand ? [{ start: base + prefixDefault.start, end: base + prefixDefault.end, text: 'mode: \'always\'' }] : null)
        }

        if (domains !== undefined) {
          const free = !spread && named('mode') === undefined && prefixDefault === undefined

          report(base + domains.start, base + domains.end, '`i18n.domains` is `i18n.mode: { domains }` since 1.105', 'write `mode: { domains }`', free ? [{ start: base + domains.start, end: base + domains.end, text: domains.shorthand ? 'mode: { domains }' : `mode: { domains: ${text.slice(domains.value.start, domains.value.end)} }` }] : null)
        }
      }
    }
  })
}
