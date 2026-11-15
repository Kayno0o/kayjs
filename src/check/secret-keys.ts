import type { CheckDiagnostic, CheckOptions } from '.'
import type { Property } from './regroup'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { configObjects, propertiesOf } from './config-objects'
import { scan } from './renamed-exports'

const NEEDLE = /\b(?:key|mcpKey|proxyKey)\b/
const TEST_KEYS = { mcpKey: 'mcp: { token }', proxyKey: 'proxy: { key: { header, secret } }' }

// The `key` of `mcp`, which is `token` since 1.105, and the string `key` of `proxy`, which names its header as `{ header }`, in the config; and the `mcpKey` and `proxyKey` options of `testSite()`, which are `config: { mcp: { token } }` and `config: { proxy: { key: { header, secret } } }`.
// The fix renames `mcp.key`, except for `false`, which has no token, and wraps the header of `proxy.key`, where the object is written in place; the options of `testSite()` are reported with no fix, as `proxy.key` needs the header the app's config names.
export async function secretKeys(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-secret-keys', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-secret-keys', NEEDLE, ({ file, parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      for (const { object, call } of configObjects(file, ast)) {
        if (call === 'testSite') {
          for (const [name, written] of Object.entries(TEST_KEYS)) {
            for (const property of propertiesOf(object, name))
              report(base + property.start, base + property.end, `\`${name}\` of \`testSite()\` is \`${written}\` in \`config\` since 1.105`, `write \`config: { ${written} }\``, null)
          }
        }

        if (call !== undefined)
          continue

        const groupOf = (name: string): Property | undefined => propertiesOf(object, name).find(property => property.value.type === 'ObjectExpression')
        const mcp = groupOf('mcp')
        const proxy = groupOf('proxy')

        for (const [group, name] of [[mcp, 'mcp'], [proxy, 'proxy']] as const) {
          if (group === undefined || group.value.type !== 'ObjectExpression')
            continue

          const inner = group.value
          const spread = inner.properties.some(property => property.type !== 'Property')

          for (const property of propertiesOf(inner, 'key')) {
            const value = property.value

            // The form of since 1.105.
            if (name === 'proxy' && value.type === 'ObjectExpression')
              continue

            const edits = fixOf(name, property, text, base, spread, value.type === 'Literal' && value.value === false, propertiesOf(inner, 'token').length > 0)

            report(base + property.start, base + property.end, name === 'mcp' ? '`mcp.key` is `mcp.token` since 1.105' : '`proxy.key` names its header as `{ header }` since 1.105', name === 'mcp' ? 'write `token`' : 'write `key: { header }`, with the key as `secret` when it is not in KAY_PROXY_KEY', edits)
          }
        }
      }
    }
  })
}

function fixOf(group: 'mcp' | 'proxy', property: Property, text: string, base: number, spread: boolean, off: boolean, taken: boolean): Edit[] | null {
  if (spread || property.kind !== 'init' || property.method)
    return null

  if (group === 'mcp') {
    if (off || taken)
      return null

    return [property.shorthand ? { start: base + property.start, end: base + property.end, text: 'token: key' } : { start: base + property.key.start, end: base + property.key.end, text: 'token' }]
  }

  return [{ start: base + property.start, end: base + property.end, text: property.shorthand ? 'key: { header: key }' : `key: { header: ${text.slice(property.value.start, property.value.end)} }` }]
}
