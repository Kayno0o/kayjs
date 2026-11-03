import type { KayCommand } from '../src/commands/command'
import { describe, expect, it, spyOn } from 'bun:test'
import { commandProject, libraryCommand, SHARED_OPTIONS, SHARED_REFUSALS } from '../src/commands/command'
import { COMMANDS } from '../src/commands/registry'

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

const LIBRARY_COMMANDS = [
  '../packages/auth/src/createUserCommand',
  '../packages/ai/src/translate',
  '../packages/ui/src/eject-command',
  '../packages/ui/src/diff-command',
  '../src/server/push-keys-command',
]

describe('the options a library command shares', () => {
  it('takes each shared option through the kit, or lists why it refuses it', async () => {
    const unexplained: string[] = []

    for (const path of LIBRARY_COMMANDS) {
      const command = (await import(path) as { default: KayCommand }).default
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
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ errors: 1, problems: [{ message: 'kay ui eject: card is ejected already' }] })
    }
    finally {
      error.mockRestore()
      log.mockRestore()
    }
  })
})
