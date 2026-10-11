import type { NextConfig } from 'next'
import { join } from 'node:path'

// Uncompressed like the other apps, and allowed to import the shared data from outside the app.
export default {
  compress: false,
  poweredByHeader: false,
  turbopack: { root: join(import.meta.dirname, '..', '..') },
} satisfies NextConfig
