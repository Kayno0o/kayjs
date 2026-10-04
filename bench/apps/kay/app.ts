import { pages } from 'kay/server'

export async function createApp() {
  return pages({ root: import.meta.dir, minify: true, prebuilt: false })
}
