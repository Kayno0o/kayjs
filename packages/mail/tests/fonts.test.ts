import { describe, expect, it } from 'bun:test'
import { html } from 'kay/html'
import defaults from '../src/defaults'
import { msoFonts, windowsStack } from '../src/mso'

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

describe('msoFonts', () => {
  it('gives Outlook for Windows a conditional style with fonts it has for the default settings', () => {
    expect(msoFonts(defaults.font, defaults.mono)).toEqual(html('<!--[if mso]><style>body,table,td,th,p,a,span,h1,h2,h3{font-family:\'Segoe UI\', Arial, sans-serif!important}.km-mono{font-family:Consolas, \'Courier New\', monospace!important}</style><![endif]-->'))
  })

  it('follows a custom font and mono setting', () => {
    const { t } = msoFonts('Georgia, \'Open Sans\', serif', '"Fira Code", monospace') as { t: string }

    expect(t).toContain('font-family:Georgia, serif!important')
    expect(t).toContain('.km-mono{font-family:\'Courier New\', monospace!important}')
    expect(t).not.toContain('Segoe UI')
  })
})
