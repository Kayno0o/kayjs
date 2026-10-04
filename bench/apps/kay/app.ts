import { pages } from 'kay/server'

// `bench:origins` serves the client it built with source maps instead of bundling one at boot.
export async function createApp() {
  return pages({ root: import.meta.dir, minify: true, prebuilt: process.env.KAY_BENCH_PREBUILT === '1' })
}
