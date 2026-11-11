import type { Mounted } from 'kay/test'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import UnnamedFields from '../tests/fixture/src/components/unnamed-fields.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('a field component nothing names logs one console warning once drawn, and a named one logs none', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

  try {
    mounted = await mountComponent(UnnamedFields)
    await settle()
    // A deliberate wait: the check runs a task after the field is drawn.
    await Bun.sleep(20)

    const said = warn.mock.calls.map(call => String(call[0])).filter(message => message.includes('has no name for a screen reader'))

    expect(said.some(message => message.includes('name="city"'))).toBe(true)
    expect(said.some(message => message.includes('name="plan"'))).toBe(true)
    expect(said.some(message => message.includes('name="street"') || message.includes('name="zip"'))).toBe(false)
  }
  finally {
    warn.mockRestore()
  }
})
