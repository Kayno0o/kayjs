import { cp, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { beforeAll, expect, test } from 'bun:test'
import { scratchDir } from '../../../tests/scratch'

const CLI = join(import.meta.dir, '../../../src/cli.ts')
const FIXTURE = join(import.meta.dir, 'fixture')
const withNull = '[{ value: null, label: \'None\' }, { value: \'a\', label: \'A\' }] as const'
const withBoth = '[{ value: \'\', label: \'Empty\' }, { value: \'a\', label: \'A\' }, { value: null, label: \'None\' }] as const'
const PLAIN = 'label="x" options={options} value={held}'

// One scratch copy of the fixture holds a component per case, checked in one `kay check` run, so the shared fixture never meets a type error.
const CASES = [
  { name: 'ok', held: '\'a\' as \'a\' | null', options: withNull, props: `${PLAIN} onChange={(value: 'a' | null) => value}` },
  { name: 'non-nullable', held: '\'a\' as \'a\'', options: withNull, props: PLAIN },
  { name: 'empty-and-null', held: '\'\' as \'\' | \'a\' | null', options: withBoth, props: PLAIN },
]
const COMPONENTS = [{ name: 'Segmented', file: 'segmented' }, { name: 'RadioGroup', file: 'radio-group' }]

let output = ''

beforeAll(async () => {
  const dir = await scratchDir('null-option-')

  await cp(FIXTURE, dir, { recursive: true, filter: source => !(/\/(?:\.kay|node_modules)$/).test(source) })
  await symlink(join(FIXTURE, 'node_modules'), join(dir, 'node_modules'))

  for (const component of COMPONENTS) {
    for (const item of CASES) {
      await Bun.write(join(dir, `src/components/${item.name}-${component.file}.kay`), `---
import ${component.name} from '@kaynooo/kayjs-ui/${component.file}.kay'

const held = ${item.held}
const options = ${item.options}
---
div
  ${component.name}(${item.props})
`)
    }
  }

  const run = Bun.spawn([process.execPath, CLI, 'check'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])

  output = out + err
  await run.exited
}, 300_000)

// The errors of one component file, each opening with `error[` and naming the file.
function errorsOf(file: string) {
  return output.split(/(?=^error\[)/m).filter(block => block.includes(`${file}.kay`)).join('')
}

for (const component of COMPONENTS) {
  test(`a ${component.name} null option on a nullable value passes, with a typed onChange inferred`, () => {
    expect(errorsOf(`ok-${component.file}`)).toBe('')
  })

  test(`a ${component.name} null option on a value that cannot be null fails kay check`, () => {
    expect(errorsOf(`non-nullable-${component.file}`)).toContain('a null option needs a value typed to allow null')
  })

  test(`a ${component.name} with an option of "" and a null option fails kay check`, () => {
    expect(errorsOf(`empty-and-null-${component.file}`)).toContain('post the same empty string')
  })
}
