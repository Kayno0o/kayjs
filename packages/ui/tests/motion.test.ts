import { join } from 'node:path'
import { Glob } from 'bun'
import { expect, test } from 'bun:test'

const SRC = join(import.meta.dir, '..', 'src')
// A time written as a bare number (`0.2s`, `150ms`, `duration-700`) rather than multiplied by the motion token.
const TIME = /(?<![\w.-])\d+(?:\.\d+)?m?s\b(?!\s*\*\s*var\(--motion-scale\))/g
const DURATION_UTILITY = /duration-\d+/g
const ANIMATE = /(?<![:\w-])(?:data-[\w-]+:)?animate-(?!none)\S+/
const DURATION_PROP = /(?:transition|animation)(?:-duration)?\s*:/

async function sources() {
  const found: { file: string, text: string }[] = []

  for (const file of new Glob('**/*.{kay,ts,css}').scanSync(SRC))
    found.push({ file, text: await Bun.file(join(SRC, file)).text() })

  return found
}

test('every transition duration of the library is multiplied by --motion-scale, which prefers-reduced-motion sets to zero', async () => {
  const bare: string[] = []

  for (const { file, text } of await sources()) {
    for (const line of text.split('\n')) {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('/*') || line.trimStart().startsWith('*'))
        continue

      // A time only counts where a transition is written: the autoplay and debounce delays are not motion.
      const motion = DURATION_PROP.test(line) || line.includes('[transition:') || DURATION_UTILITY.test(line)

      if (!motion)
        continue

      for (const match of [...line.matchAll(TIME), ...line.matchAll(DURATION_UTILITY)])
        bare.push(`${file}: ${match[0]}`)
    }
  }

  expect(bare).toEqual([])
})

test('the stylesheet sets the motion token to zero under reduced motion, and Tailwind\'s default duration follows it', async () => {
  const css = await Bun.file(join(SRC, 'theme.css')).text()
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))

  expect(css).toContain('--motion-scale: 1;')
  expect(block.slice(0, block.indexOf('}\n  }') + 5)).toContain('--motion-scale: 0;')
  expect(block).toContain('--default-transition-duration: calc(150ms * var(--motion-scale))')
})

test('every animation utility is stilled under reduced motion', async () => {
  const loose: string[] = []

  for (const { file, text } of await sources()) {
    for (const line of text.split('\n')) {
      if (ANIMATE.test(line) && !line.includes('motion-reduce:'))
        loose.push(`${file}: ${line.trim().slice(0, 80)}`)
    }
  }

  expect(loose).toEqual([])
})
