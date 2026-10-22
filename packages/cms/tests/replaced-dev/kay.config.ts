import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'
import { cms } from '../../src/extension'

// The app replaces the cms's own dev module, so its mount is not the first anchor the guard finds.
export default defineConfig({
  extensions: [cms({})],
  plugins: [tailwind],
})
