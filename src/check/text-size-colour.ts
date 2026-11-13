import type { CheckDiagnostic, CheckOptions } from '.'
import { CSS_FILE, findProjectFiles, KAY_FILE } from '../build/files'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { blank, blankComments } from './removed-ui-tokens'

const COMMENT = /\/\*[\s\S]*?\*\//g
const SIZE = 'xs|sm|base|lg|xl|[2-9]xl'
// A colour of the app's theme named like a size of Tailwind's `text-` utility: `--color-base`.
const DECLARED = new RegExp(`(?<![\\w-])--color-(${SIZE})\\s*:`, 'g')

// A `--color-base` makes `text-base` the text colour as well as the font size, so every use of the size also paints the text that colour: the page background, in a palette where `base` is the ground.
export async function textSizeColour(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('text-size-colour', options.lints)

  if (level === 'allow')
    return []

  const files = [...await findProjectFiles(root, CSS_FILE, { project: true, ownOnly: true }), ...await findProjectFiles(root, KAY_FILE, { project: true, ownOnly: true })]
  const sources = await Promise.all(files.map(async (file) => {
    const source = await Bun.file(file).text()

    return { file, source, code: CSS_FILE.test(file) ? source.replace(COMMENT, blank) : blankComments(source) }
  }))
  const names = new Set(sources.flatMap(({ code, file }) => CSS_FILE.test(file) ? [...code.matchAll(DECLARED)].map(match => match[1]!) : []))

  if (names.size === 0)
    return []

  const use = new RegExp(`(?<![\\w-])text-(${[...names].join('|')})(?![\\w-])`, 'g')
  const found: CheckDiagnostic[] = []

  for (const { file, source, code } of sources) {
    const levelAt = lintLevels(source, options.lints)

    for (const match of code.matchAll(use)) {
      const at = levelAt('text-size-colour', match.index)
      const name = match[1]!

      if (at === 'allow')
        continue

      found.push({
        file,
        ...positionAt(source, match.index),
        end: match.index + match[0].length,
        message: `\`text-${name}\` sets the font size and, as \`--color-${name}\` is a colour of the theme, the text colour too`,
        help: `rename the colour (\`--color-${name}\` to \`--color-background\`, say) and write \`text-background\` where the colour was meant, or keep \`text-${name}\` for the size alone: \`text-[1rem]\` is the size without the colour`,
        code: 'text-size-colour',
        severity: at === 'warn' ? 'warning' : 'error',
      })
    }
  }

  return found
}
