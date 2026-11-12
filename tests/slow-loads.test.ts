import type { Rendering } from '../src/server/render'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { loadBudgetMs } from '../src/server/config-limits'
import { warnSlowLoads } from '../src/server/load-budget'

const FILES = ['/app/src/routes/_layout.kay', '/app/src/routes/index.kay', '/app/src/routes/side.kay']

describe('the load budget of a page in development', () => {
  const warned = spyOn(console, 'warn').mockImplementation(() => undefined)

  afterEach(() => warned.mockClear())

  const run = (timings: number[], took: number, loadBudget?: `${number}ms` | false) => {
    const rendering = {} as Rendering

    warnSlowLoads('/app/src/routes/index.kay', FILES, timings, took, rendering, loadBudget === undefined ? {} : { observe: { loadBudget } })

    return rendering
  }

  it('warns past 300 ms by default, naming the slowest load, and records it for the dev tool', () => {
    const rendering = run([20, 420, 90], 430)

    expect(rendering.slow).toMatchObject({ ms: 420, took: 430, budget: 300 })
    expect(rendering.slow!.file).toEndWith('routes/index.kay')
    expect(warned).toHaveBeenCalledTimes(1)
    expect(String(warned.mock.calls[0]![0])).toMatch(/took 430 ms, over the 300 ms of `observe.loadBudget`; the slowest, `load-1` \(.*index\.kay\), took 420 ms/)
  })

  it('stays quiet at or under the budget', () => {
    expect(run([20, 250, 90], 300).slow).toBeUndefined()
    expect(warned).not.toHaveBeenCalled()
  })

  it('takes the budget the config sets, and none for false', () => {
    expect(run([20, 250, 90], 260, '200ms').slow).toMatchObject({ budget: 200, file: expect.stringMatching(/index\.kay$/) })
    expect(run([20, 250, 90], 260, '500ms').slow).toBeUndefined()
    expect(run([20, 4000, 90], 4100, false).slow).toBeUndefined()
    expect(warned).toHaveBeenCalledTimes(1)
  })

  it('reads the budget as a duration, 300 ms unset, and refuses anything else', () => {
    expect(loadBudgetMs(undefined)).toBe(300)
    expect(loadBudgetMs('1s')).toBe(1000)
    expect(loadBudgetMs(false)).toBeUndefined()
    expect(() => loadBudgetMs('soon' as never)).toThrow()
  })
})
