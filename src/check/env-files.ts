import type { CheckDiagnostic, CheckOptions } from '.'
import { basename } from 'node:path'
import { lintLevel } from '../compiler/lints'
import { constBindings, exportedObject, keyName } from '../compiler/object-literal'
import { scan } from './renamed-exports'

const ENV = /\benv\b/

// `env` in kay.config.ts, `envFiles` since 1.105: the key names the compose and example files the declared variables are compared with, where `env` read as the variables themselves. The fix renames the key; a config that already has an `envFiles`, or a computed key, is reported with no fix.
export async function envFiles(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-env-files', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-env-files', ENV, ({ file, parsed, report }) => {
    if (basename(file) !== 'kay.config.ts')
      return

    for (const { ast, base } of parsed) {
      const properties = exportedObject(ast, constBindings(ast))?.properties.filter(property => property.type === 'Property') ?? []
      const old = properties.find(property => keyName(property) === 'env')

      if (old === undefined)
        continue

      const fixable = !old.computed && !properties.some(property => keyName(property) === 'envFiles')
      const edits = fixable ? [old.shorthand ? { start: base + old.start, end: base + old.end, text: 'envFiles: env' } : { start: base + old.key.start, end: base + old.key.end, text: 'envFiles' }] : []

      report(base + old.start, base + old.end, '`env` in kay.config.ts is deprecated since 1.105: it names the compose and example files the declared variables are compared with, `envFiles`', 'write `envFiles`', edits)
    }
  })
}
