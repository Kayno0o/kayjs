import type { KayCommand } from '../src/commands/command'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { ai } from '../packages/ai/src/extension'
import { auth } from '../packages/auth/src/pages'
import { ui } from '../packages/ui/src/extension'
import { commandProject, libraryCommand, SHARED_OPTIONS, SHARED_REFUSALS } from '../src/commands/command'
import { COMMANDS } from '../src/commands/registry'
import { push } from '../src/server/push'
import { scratchDir } from './scratch'

const own = COMMANDS.filter(command => command.load !== undefined)

describe('the options every command shares', () => {
  it('takes each of --quiet, --format and --dry-run or lists why it refuses it', async () => {
    const unexplained: string[] = []
    const contradicted: string[] = []

    for (const { name, load } of own) {
      const { options } = await load!()

      for (const option of SHARED_OPTIONS) {
        const refusal = SHARED_REFUSALS[name]?.[option]

        if (option in options && refusal !== undefined)
          contradicted.push(`kay ${name} takes --${option} and lists a reason to refuse it`)
        else if (!(option in options) && refusal === undefined)
          unexplained.push(`kay ${name} neither takes --${option} nor lists why`)
      }
    }

    expect(unexplained).toEqual([])
    expect(contradicted).toEqual([])
  })

  it('lists refusals only for commands and options that exist', () => {
    const names = new Set(own.map(command => command.name))

    for (const [name, refused] of Object.entries(SHARED_REFUSALS)) {
      expect(names.has(name)).toBe(true)
      expect(Object.keys(refused).every(option => (SHARED_OPTIONS as readonly string[]).includes(option))).toBe(true)
    }
  })
})

// The command modules the libraries' extensions declare, so a new one cannot skip the check.
const LIBRARY_COMMANDS = [ai(), auth(), ui(), push()].flatMap(extension => Object.values(extension.commands ?? {}))

describe('the options a library command shares', () => {
  it('takes each shared option through the kit, or lists why it refuses it', async () => {
    const unexplained: string[] = []

    for (const path of LIBRARY_COMMANDS) {
      const command = (await import(path) as { default: KayCommand }).default

      expect(LIBRARY_COMMANDS.length).toBeGreaterThanOrEqual(5)
      const { options } = libraryCommand(command, command.usage, '.', {})

      for (const option of SHARED_OPTIONS) {
        const refusal = command.refuses?.[option]

        if (option in options && refusal !== undefined && !(option in command.options))
          unexplained.push(`${command.usage} takes --${option} and lists a reason to refuse it`)
        else if (!(option in options) && refusal === undefined)
          unexplained.push(`${command.usage} neither takes --${option} nor lists why`)
      }
    }

    expect(unexplained).toEqual([])
  })

  it('reports a failure as text on stderr, or as a document under --format json', () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    const log = spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      expect(commandProject('ui eject', '.', {}).fail('card is ejected already')).toBe(1)
      expect(error.mock.calls.flat()).toEqual(['kay ui eject: card is ejected already'])
      expect(log).not.toHaveBeenCalled()
      expect(commandProject('ui eject', '.', {}, { format: 'json' }).fail('card is ejected already')).toBe(1)
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ errors: 1, problems: [{ code: 'command-usage', message: 'card is ejected already' }] })
      expect(commandProject('ui eject', '.', {}, { format: 'json' }).fail('the model failed', null)).toBe(1)
      expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({ problems: [{ code: null, message: 'the model failed' }] })
    }
    finally {
      error.mockRestore()
      log.mockRestore()
    }
  })
})

const cli = join(import.meta.dir, '../src/cli.ts')
const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

// A project whose extension adds commands: one taking the shared options, one declaring its own --format, --quiet and --dry-run, one refusing --dry-run.
async function project(): Promise<string> {
  const root = await scratchDir('library-command-')
  const files: Record<string, string> = {
    'kay.config.ts': 'export default { favicon: false, extensions: [{ name: \'kay-lib\', commands: { \'lib shared\': \'./lib/shared.ts\', \'lib own\': \'./lib/own.ts\', \'lib refusing\': \'./lib/refusing.ts\' } }] }\n',
    'lib/shared.ts': 'export default { usage: \'lib shared <what>\', options: {}, positionals: 1, run: ({ positionals: [what] }, refuse, { format, quiet, dryRun, fail, result }) => {\n  if (what === \'broken\')\n    return fail(\'it broke\', null)\n\n  if (what === \'usage\')\n    return fail(\'bad input\')\n\n  result({ what, dryRun })\n\n  if (format === \'text\' && !quiet)\n    console.log(`${dryRun ? \'would do\' : \'did\'} ${what}`)\n\n  return 0\n} }\n',
    'lib/own.ts': 'export default { usage: \'lib own\', options: { format: { type: \'string\' }, quiet: { type: \'string\' }, \'dry-run\': { type: \'string\' } }, positionals: 0, run: ({ values }, refuse, { format, quiet, dryRun }) => {\n  console.log(JSON.stringify({ values, format, quiet, dryRun }))\n\n  return 0\n} }\n',
    'lib/refusing.ts': 'export default { usage: \'lib refusing\', options: {}, refuses: { \'dry-run\': \'writes nothing\' }, positionals: 0, run: () => 0 }\n',
  }

  dirs.push(root)
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function kay(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: { PATH: process.env.PATH! }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

describe('a library command through kay', () => {
  it('takes --quiet, --format json and --dry-run, and prints a failure through the shared reporter', async () => {
    const root = await project()

    expect(await kay(['lib', 'shared', 'x'], root)).toMatchObject({ code: 0, stdout: 'did x\n' })
    expect(await kay(['lib', 'shared', 'x', '--dry-run'], root)).toMatchObject({ code: 0, stdout: 'would do x\n' })
    expect(await kay(['lib', 'shared', 'x', '--quiet'], root)).toMatchObject({ code: 0, stdout: '' })

    const json = await kay(['lib', 'shared', 'x', '--format', 'json'], root)

    expect(JSON.parse(json.stdout)).toEqual({ what: 'x', dryRun: false })

    const broken = await kay(['lib', 'shared', 'broken', '--format', 'json'], root)

    expect(broken.code).toBe(1)
    expect(broken.stderr).toContain('kay lib shared: it broke')
    expect(JSON.parse(broken.stdout)).toMatchObject({ errors: 1, problems: [{ code: null, message: 'it broke' }] })
    expect(JSON.parse((await kay(['lib', 'shared', 'usage', '--format', 'json'], root)).stdout)).toMatchObject({ problems: [{ code: 'command-usage' }] })
    expect((await kay(['lib', 'shared', 'broken'], root)).stdout).toBe('')
  })

  it('refuses a --format that is neither text nor json with exit 2', async () => {
    const result = await kay(['lib', 'shared', 'x', '--format', 'csv'], await project())

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--format takes `text` or `json`, not `csv`')
  })

  it('leaves --format, --quiet and --dry-run to a command that declares them', async () => {
    const result = await kay(['lib', 'own', '--format', 'csv', '--quiet', 'loud', '--dry-run', 'yes'], await project())

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ values: { 'format': 'csv', 'quiet': 'loud', 'dry-run': 'yes' }, format: 'text', quiet: false, dryRun: false })
  })

  it('does not take an option it refuses', async () => {
    expect((await kay(['lib', 'refusing', '--dry-run'], await project())).code).toBe(2)
  })
})
