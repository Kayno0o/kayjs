import type { Setup } from './template-shared'
import { lines, quote } from './template-shared'

// Over the app's own database, loaded as the server starts so the config stays off it.
const POSTGRES_STORE = ', store: async () => (await import(\'@kaynooo/kayjs-auth/pg\')).pgStore((await import(\'./src/db\')).db)'

export function config({ has, settings }: Setup): string {
  const server = has('server')
  const base = settings.base === undefined ? undefined : quote(settings.base)

  return lines(
    has('auth') && 'import { auth } from \'@kaynooo/kayjs-auth\'',
    has('auth') && 'import { ui } from \'@kaynooo/kayjs-ui/extension\'',
    !server && base !== undefined && 'import process from \'node:process\'',
    has('tailwind') && 'import tailwind from \'bun-plugin-tailwind\'',
    'import { defineConfig } from \'kay/server\'',
    '',
    !server && '// kay reads the host the site is published on from SITE_URL and the path it is published under from SITE_BASE, which the Pages workflow sets when building.',
    'export default defineConfig({',
    has('auth') && `  extensions: [auth({ name: '__SITE__'${has('postgres') ? POSTGRES_STORE : ''} }), ui()],`,
    `  lang: ${quote(settings.lang ?? 'en')},`,
    settings.site !== undefined && `  site: ${quote(settings.site)},`,
    base !== undefined && `  base: ${server ? base : `process.env.SITE_BASE ?? ${base}`},`,
    has('tailwind') && '  plugins: [tailwind],',
    settings.fonts !== undefined && settings.fonts.length > 0 && `  fonts: [${settings.fonts.map(font => `{ fontsource: ${quote(font.fontsource)}${font.weights ? `, weights: [${font.weights.join(', ')}]` : ''}${font.styles ? `, styles: [${font.styles.map(quote).join(', ')}]` : ''}${font.subsets ? `, subsets: [${font.subsets.map(quote).join(', ')}]` : ''} }`).join(', ')}],`,
    server && has('docker') && '  // The compose file binds 127.0.0.1 for a reverse proxy: with this the visitor\'s address, which rate limits count, is the one the proxy passes on and not the proxy\'s. It trusts private-range peers, so a dev server bound to 0.0.0.0 believes a LAN client\'s X-Forwarded-For.',
    server && has('docker') && '  proxy: true,',
    settings.seo !== false && '  seo: { name: \'__NAME__\', titleTemplate: \'%s | __NAME__\', description: \'__NAME__, made with kay\' },',
    '})',
  )
}

export const SERVER_ENTRY = `import { Elysia } from 'elysia'
import { pages } from 'kay/server'

// Exported for \`kay check\`, which checks links against the routes it serves besides the pages and types \`ctx.locals\` from its plugins.
export const app = new Elysia().use(await pages())
`
