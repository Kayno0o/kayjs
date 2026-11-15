import type { CheckDiagnostic, CheckOptions } from '.'
import { lintLevel } from '../compiler/lints'
import { configObjects } from './config-objects'
import { nameOf, regrouped } from './regroup'
import { scan } from './renamed-exports'

const NEEDLE = /\b(?:links|offline|search)\b/
const HELP = 'write the key in `client`, `client: { links, offline, search }`'
const MOVED = new Set(['links', 'offline', 'search'])

const movedTo = (name: string): [string, string] | undefined => MOVED.has(name) ? ['client', name] : undefined

// The keys `links`, `offline` and `search` of the config, which belong to `client` since 1.105, with the rest of what the browser is given.
// The fix, from the first report of an object, moves them into `client` as written, and offers none where the object spreads, holds a computed key, or has a `client` already.
export async function clientKeys(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-client-keys', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-client-keys', NEEDLE, ({ file, parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      for (const { object, call } of configObjects(file, ast)) {
        // The options of a call are moved into `config` by `deprecated-pages-options` first.
        if (call !== undefined)
          continue

        const old = object.properties.filter(property => property.type === 'Property' && !property.computed && movedTo(nameOf(property)) !== undefined)
        const fixed = old.length === 0 ? undefined : regrouped(object, text, movedTo, true)

        for (const [index, property] of old.entries())
          report(base + property.start, base + property.end, `\`${nameOf(property)}\` of the config is \`client.${nameOf(property)}\` since 1.105`, HELP, index === 0 && fixed !== undefined ? fixed.map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end })) : null)
      }
    }
  })
}
