import type { CheckDiagnostic, CheckOptions } from '.'
import { basename } from 'node:path'
import { lintLevel } from '../compiler/lints'
import { constBindings, exportedObject, objectOf } from '../compiler/object-literal'
import { featureProperties } from './config-objects'
import { nameOf, regrouped } from './regroup'
import { scan } from './renamed-exports'

const NEEDLE = /\bimages\b/
const HELP = 'group the key, `remote: { maxSize, timeout }`, `formats: { quality, webp, avif }`, `limits: { variants, queue }`'

// Each flat key of `images` before 1.105 and the group and part it became.
const MOVED: Record<string, [string, string]> = {
  remoteMaxSize: ['remote', 'maxSize'],
  remoteTimeout: ['remote', 'timeout'],
  maxVariants: ['limits', 'variants'],
  queue: ['limits', 'queue'],
  quality: ['formats', 'quality'],
  webp: ['formats', 'webp'],
  avif: ['formats', 'avif'],
}

const movedTo = (name: string): [string, string] | undefined => Object.hasOwn(MOVED, name) ? MOVED[name] : undefined

// The flat keys of `images` in kay.config.ts, grouped since 1.105: `remote: { hosts, maxSize, timeout }`, `formats: { quality, webp, avif }`, `limits: { variants, queue }`.
// The fix, from the first report of an object, moves only those keys and offers none where the object spreads, holds a computed or shorthand key, names a part twice or already has the group.
export async function imagesKeys(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-images-keys', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-images-keys', NEEDLE, ({ file, parsed, report }) => {
    if (basename(file) !== 'kay.config.ts')
      return

    for (const { ast, base, text } of parsed) {
      const bindings = constBindings(ast)
      const exported = exportedObject(ast, bindings)

      for (const images of exported === undefined ? [] : featureProperties(exported, bindings, 'assets', 'images')) {
        const object = objectOf(images.value, bindings)
        const old = object?.properties.filter(property => property.type === 'Property' && !property.computed && movedTo(nameOf(property)) !== undefined) ?? []

        if (object === undefined || old.length === 0)
          continue

        // A bound object lives elsewhere in the file, so its keys are found and not rewritten from here.
        const fixed = images.value === object ? regrouped(object, text, movedTo) : undefined

        for (const [index, property] of old.entries())
          report(base + property.start, base + property.end, `\`images.${nameOf(property)}\` is grouped since 1.105`, HELP, index === 0 && fixed !== undefined ? fixed.map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end })) : null)
      }
    }
  })
}
