import { describe, expect, it } from 'bun:test'
import { windowsStack } from '../src/mso'

describe('windowsStack', () => {
  it('keeps the fonts Windows has and the generic family, so Outlook never falls back to Times New Roman', () => {
    expect(windowsStack('system-ui, -apple-system, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif')).toBe('\'Segoe UI\', Arial, sans-serif')
    expect(windowsStack('ui-monospace, \'SF Mono\', Menlo, Consolas, \'Courier New\', monospace')).toBe('Consolas, \'Courier New\', monospace')
  })

  it('stands a font Windows has in for a stack holding none, after its generic family', () => {
    expect(windowsStack('\'Open Sans\', sans-serif')).toBe('Arial, sans-serif')
    expect(windowsStack('Lora, serif')).toBe('Georgia, serif')
    expect(windowsStack('"Fira Code", monospace')).toBe('\'Courier New\', monospace')
    expect(windowsStack('Inter')).toBe('Arial, sans-serif')
  })
})
