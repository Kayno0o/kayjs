# Renaming an entry's slug

## Savers

A `FileSaver` may have `move(move)`, which renames a folder entry's file: `move.from` and `move.to` each hold `repoPath` and `absolute`, `move.text` is the text the file has at `to`, `move.base` the version of `from` (as `change.base` for a save), and `move.message` and `move.author` as in a save. It writes `to` and removes `from` in one step and throws `SaveConflict` when `from` is at another version or gone (`current` is its version, `null` once gone), or when `to` exists (`new SaveConflict(undefined, true)`). `forgejo()` commits the move as one commit (a delete and a create, which git reads as a rename) and `workingTree()` does it in place. A saver without `move` cannot rename entries.
