import { expect, it, spyOn } from 'bun:test'
import { warnUnnamed } from '../src/unnamed'

function field(attributes: Record<string, string>, labels: unknown[] = []) {
  return ({
    localName: 'input',
    type: 'text',
    isConnected: true,
    labels,
    getAttribute: (name: string) => attributes[name] ?? null,
  }) as unknown as Element
}

it('warns once of a field nothing names, and stays quiet for one a label, aria-label, aria-labelledby or title names', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

  try {
    warnUnnamed(field({ name: 'city' }))
    warnUnnamed(field({ name: 'city' }))
    warnUnnamed(field({ 'name': 'a', 'aria-label': 'A' }))
    warnUnnamed(field({ 'name': 'b', 'aria-labelledby': 'x' }))
    warnUnnamed(field({ name: 'c', title: 'C' }))
    warnUnnamed(field({ name: 'd' }, [{}]))
    warnUnnamed(field({ 'name': 'e', 'aria-label': '  ' }))
    await Bun.sleep(10)

    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
      expect.stringContaining('name="city"'),
      expect.stringContaining('name="e"'),
    ])
    expect(String(warn.mock.calls[0]![0])).toContain('FormField')
  }
  finally {
    warn.mockRestore()
  }
})
