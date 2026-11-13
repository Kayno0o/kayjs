import type { Feature } from '../src/new'
import { describe, expect, it } from 'bun:test'
import { PRESETS, projectFiles } from '../src/new'

// What the starter scaffolds: the look of orbit's apps, over kayjs-ui's space skin.
describe('the starter', () => {
  it('sizes the accent picker popover to its twelve swatches, the accents of orbit under names of the starter\'s own', async () => {
    const files = await projectFiles('/x/app', new Set<Feature>([...PRESETS.app.features, 'accents']), '^1.0.0')

    expect(files['src/components/accent-picker.kay']).toContain('grid w-max grid-cols-6')
    expect(files['src/theme.ts']).toContain('[\'starlight\', \'mint\', \'orchid\', \'periwinkle\', \'rose\', \'sky\', \'lime\', \'amber\', \'lilac\', \'sand\', \'peach\', \'coral\']')
    expect(files['src/app.css']).toContain('--accent-mint: #7ee0b3;')
    expect(files['src/app.css']).toContain('--color-accent: var(--accent, var(--accent-starlight));')
  })

  it('scaffolds the look of orbit through the space skin of kayjs-ui, its fonts and the AppHeader, in every preset with a starter', async () => {
    for (const preset of [PRESETS.server, PRESETS.site, PRESETS.app]) {
      const files = await projectFiles('/x/app', new Set<Feature>(preset.features), '^1.0.0')
      const manifest = JSON.parse(files['package.json']!) as { dependencies: Record<string, string>, devDependencies: Record<string, string> }

      expect(files['src/app.css']).toContain('@import \'@kayjs/ui/skins/space.css\';')
      expect(files['src/app.css']).toContain('--color-background: #090a10;')
      expect(files['src/app.css']).toContain('--color-foreground: #d8dbe6;')
      expect(files['src/app.css']).toContain('body::before')
      expect(files['src/app.css']).toContain('@supports (top: random(0px, 1px))')
      // A static export holds no extension's API routes, so a site imports the theme where a server mounts it.
      expect(files['kay.config.ts']!.includes('ui()')).toBe(preset.features.includes('server'))
      expect(files['src/app.css']!.includes('@import \'@kayjs/ui/theme.css\';')).toBe(!preset.features.includes('server'))
      expect(files['kay.config.ts']).toContain('fonts: [{ fontsource: \'@fontsource-variable/space-grotesk\' }, { fontsource: \'@fontsource-variable/jetbrains-mono\' }]')
      expect(files['src/components/header.kay']).toContain('import AppHeader from \'@kayjs/ui/app-header.kay\'')
      expect(Object.keys(manifest.dependencies)).toContain('@kayjs/ui')
      expect(Object.keys(manifest.devDependencies)).toEqual(expect.arrayContaining(['@fontsource-variable/space-grotesk', '@fontsource-variable/jetbrains-mono']))
    }
  })

  // `text-base` is also the 1rem font size, so a colour named like a size paints text that colour (#3294).
  it('names no colour of its palette like a Tailwind text size, and draws no text in the background colour', async () => {
    const SIZE_COLOUR = /--color-(?:xs|sm|base|lg|xl|[2-9]xl)\s*:/
    const SIZE_UTILITY = /(?<![\w-])(?:bg|border|decoration|ring|fill|stroke)-(?:xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/

    for (const features of [PRESETS.server.features, PRESETS.site.features, PRESETS.app.features, [...PRESETS.site.features, 'accents'] as Feature[], ['starter', 'tailwind'] as Feature[], ['tailwind'] as Feature[]]) {
      const files = await projectFiles('/x/app', new Set<Feature>(features), '^1.0.0')

      expect(files['src/app.css']).not.toMatch(SIZE_COLOUR)

      for (const [path, content] of Object.entries(files)) {
        if (path.startsWith('src/') && !path.endsWith('.css'))
          expect({ features, path, text: SIZE_UTILITY.test(content) }).toEqual({ features, path, text: false })
      }

      expect(files['src/app.css']).not.toMatch(/--color-base|text-base/)
    }
  })
})
