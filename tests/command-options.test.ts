import { describe, expect, it } from 'bun:test'
import { SHARED_OPTIONS, SHARED_REFUSALS } from '../src/commands/command'
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
