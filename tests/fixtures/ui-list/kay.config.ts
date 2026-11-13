import { ui } from '@kayjs/ui/extension'
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

// A list page as an app on kayjs-ui writes one, whose eager JS `scripts/sizes.ts` holds.
export default defineConfig({ plugins: [tailwind], extensions: [ui()], observe: { log: false }, requireGuards: false })
