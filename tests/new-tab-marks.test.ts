import { Glob } from 'bun'
import { expect, test } from 'bun:test'

const LITERAL = /target="_blank"/

// A literal `target="_blank"` in a source carries `data-new-tab`, the mark the page's rule reads to say "(opens in a new tab)" to a screen reader.
test('every literal target="_blank" in the libraries is marked data-new-tab', async () => {
  const unmarked: string[] = []

  for (const pattern of ['packages/*/src/**/*.{kay,ts}']) {
    for await (const file of new Glob(pattern).scan({ cwd: `${import.meta.dir}/..` })) {
      const lines = (await Bun.file(`${import.meta.dir}/../${file}`).text()).split('\n')

      for (const [index, line] of lines.entries()) {
        if (LITERAL.test(line) && !line.includes('data-new-tab'))
          unmarked.push(`${file}:${index + 1}`)
      }
    }
  }

  expect(unmarked).toEqual([])
})
