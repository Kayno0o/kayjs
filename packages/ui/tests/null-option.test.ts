import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, expect, test } from 'bun:test'

const CLI = join(import.meta.dir, '../../../src/cli.ts')
const FIXTURE = join(import.meta.dir, 'fixture')
const withNull = '[{ value: null, label: \'None\' }, { value: \'a\', label: \'A\' }] as const'
const withBoth = '[{ value: \'\', label: \'Empty\' }, { value: \'a\', label: \'A\' }, { value: null, label: \'None\' }] as const'
const FILE = join(FIXTURE, 'src/components/null-option-scratch.kay')

afterAll(async () => rm(FILE, { force: true }))

async function check(component: string, held: string, options: string, groups: string) {
  const file = component === 'Segmented' ? 'segmented' : 'radio-group'

  await Bun.write(FILE, `---
import ${component} from '@kaynooo/kayjs-ui/${file}.kay'

const held = ${held}
const options = ${options}
---
div
  ${component}(${groups})
`)

  const run = Bun.spawn([process.execPath, CLI, 'check'], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])

  return { code: await run.exited, text: out + err }
}

for (const component of ['Segmented', 'RadioGroup']) {
  test(`a ${component} null option on a nullable value passes, with a typed onChange inferred`, async () => {
    const { code, text } = await check(component, '\'a\' as \'a\' | null', withNull, `label="x" options={options} value={held} onChange={(value: 'a' | null) => value}`)

    expect(text).not.toContain('null-option-scratch')
    expect(code).toBe(0)
  }, 120_000)

  test(`a ${component} null option on a value that cannot be null fails kay check`, async () => {
    const { code, text } = await check(component, '\'a\' as \'a\'', withNull, 'label="x" options={options} value={held}')

    expect(text).toContain('a null option needs a value typed to allow null')
    expect(code).not.toBe(0)
  }, 120_000)

  test(`a ${component} with an option of "" and a null option fails kay check`, async () => {
    const { code, text } = await check(component, '\'\' as \'\' | \'a\' | null', withBoth, 'label="x" options={options} value={held}')

    expect(text).toContain('post the same empty string')
    expect(code).not.toBe(0)
  }, 120_000)
}
