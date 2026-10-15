import { defineConfig } from 'kay/server'

export default defineConfig({
  site: 'https://cards.example',
  seo: { name: 'Cards' },
  fonts: [{ family: 'Archivo Black', src: 'src/fonts/archivo-black-latin-400-normal.woff2' }],
  images: { card: { logo: 'src/logo.svg' } },
})
