import { pages } from 'kay/server'

export async function createApp() {
  return pages({ root: import.meta.dir, routes: 'routes', minify: true, prebuilt: false })
}
