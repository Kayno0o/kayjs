import type { CheckDiagnostic, CheckOptions } from '.'
import type { Property } from './regroup'
import { lintLevel } from '../compiler/lints'
import { CONFIG_KEYS } from '../config-shape'
import { configObjects, isProperty, propertyOf } from './config-objects'
import { nameOf, regrouped } from './regroup'
import { scan } from './renamed-exports'

const NEEDLE = /\b(?:pages|testSite)\b/

// The config keys written beside `root` in the options of `pages()` and `testSite()`, `config` since 1.105: the options are the project's own (`root`, `dev`, `prebuilt`, and a test site's `browser`, `headers` and the like) and the config they lay over `kay.config.ts` is one key, not a copy of the config's whole shape.
// The fix, from the first report of a call, moves the keys into a new `config` and offers none where the options spread, hold a computed key or have a `config` already.
export async function pagesOptions(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-pages-options', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-pages-options', NEEDLE, ({ parsed, file, report }) => {
    for (const { ast, base, text } of parsed) {
      for (const { object, call, others } of configObjects(file, ast)) {
        if (call === undefined)
          continue

        const old = object.properties.filter((property): property is Property => isProperty(property) && !property.computed && CONFIG_KEYS.has(nameOf(property)) && !others.includes(nameOf(property)))

        if (old.length === 0)
          continue

        const fixed = propertyOf(object, 'config') === undefined ? regrouped(object, text, name => CONFIG_KEYS.has(name) && !others.includes(name) ? ['config', name] : undefined, true) : undefined

        for (const [index, property] of old.entries())
          report(base + property.start, base + property.end, `\`${nameOf(property)}\` beside the options of \`${call}()\` is deprecated since 1.105: the config is one key, \`config\``, `write \`config: { ${nameOf(property)} }\``, index === 0 && fixed !== undefined ? fixed.map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end })) : null)
      }
    }
  })
}
