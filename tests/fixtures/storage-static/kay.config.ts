import process from 'node:process'
import { defineConfig, diskFiles, memoryFiles } from 'kay/server'

// The test exports it once on the server's disk, then once with a store a CDN serves.
export default defineConfig({
  storage: process.env.KAY_TEST_FILES_URL ? { ...memoryFiles(), publicUrl: process.env.KAY_TEST_FILES_URL } : diskFiles('data/files'),
})
