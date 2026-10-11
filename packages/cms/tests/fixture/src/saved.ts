import type { FileChange, FileSaver } from '@kaynooo/kayjs-cms'

// The files the screens saved, kept rather than written, which the tests read back.
export const saved: FileChange[] = []

export const recorder: FileSaver = {
  async save(change) {
    saved.push(change)

    return { sha: 'c0ffee' }
  },
}
