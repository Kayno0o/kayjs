import type { CheckDiagnostic, CheckOptions } from '.'
import type { Attribute } from '../compiler/ast'
import type { Edit } from './renamed-exports'
import { findProjectFiles } from '../build/files'
import { elementsIn } from '../compiler/ast'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'

// The modifier each component put before its `hotkey`: Alt for the Toaster, Ctrl or Cmd for the CommandPalette.
const CHORDS: Record<string, string> = { Toaster: 'alt+', CommandPalette: 'mod+' }
const OFF = new Set(['null', 'false'])
const NEEDLE = /\bhotkey\b/
const KAY_FILE = /\.kay$/

// `hotkey` of a kayjs-ui Toaster or CommandPalette, `shortcut` since 1.97: the full chord, as SaveForm's `shortcut` already is, with `false` or `null` turning it off.
// A literal key or `{null}` is rewritten; any other value is reported with no fix, as the chord is built from it.
export async function uiHotkey(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-ui-hotkey', options.lints) === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, KAY_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!NEEDLE.test(source) || !source.includes('kayjs-ui'))
      continue

    const levelAt = lintLevels(source, options.lints)

    for (const element of elementsIn(parseKay(source).template)) {
      const chord = element.component ? CHORDS[element.name] : undefined

      if (chord === undefined)
        continue

      for (const attribute of element.attributes) {
        if (attribute.kind === 'spread' || source.slice(attribute.name.start, attribute.name.end) !== 'hotkey')
          continue

        const level = levelAt('deprecated-ui-hotkey', attribute.name.start)

        if (level === 'allow')
          continue

        const edits = rewrite(source, attribute, chord)

        found.push({
          file,
          ...positionAt(source, attribute.name.start),
          end: attribute.name.end,
          message: `\`hotkey\` of ${element.name} is \`shortcut\` since 1.97: the full chord, as SaveForm's \`shortcut\` is, and \`false\` or \`null\` turns it off; \`hotkey\` still works until it is removed`,
          help: `write \`shortcut="${chord}<key>"\``,
          code: 'deprecated-ui-hotkey',
          severity: level === 'warn' ? 'warning' : 'error',
          ...edits && { fixes: [{ title: 'Write `shortcut` with the full chord', edits, safe: true }] },
        })
      }
    }
  }

  return found
}

function rewrite(source: string, attribute: Exclude<Attribute, { kind: 'spread' }>, chord: string): Edit[] | undefined {
  if (attribute.kind === 'static') {
    const key = attribute.text
    // The closing quote is not in the value's span.
    const end = attribute.value.end + 1

    return [{ start: attribute.name.start, end, text: key === '' ? 'shortcut={null}' : `shortcut="${chord}${key}"` }]
  }

  if (attribute.kind === 'expression' && OFF.has(source.slice(attribute.expression.start, attribute.expression.end).trim()))
    return [{ start: attribute.name.start, end: attribute.name.end, text: 'shortcut' }]

  return undefined
}
