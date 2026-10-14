import process from 'node:process'
import { defineConfig, diskFiles, memoryFiles } from 'kay/server'

// The test exports it with a store a CDN serves; without KAY_TEST_FILES_URL, its store on the server's disk refuses a static export.
export default defineConfig({
  storage: process.env.KAY_TEST_FILES_URL ? { ...memoryFiles(), publicUrl: process.env.KAY_TEST_FILES_URL } : diskFiles('data/files'),
})
