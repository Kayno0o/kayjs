// What `kay dev` and the process writing its types say to each other when a config that does not load stops the start.
export const REFUSE = 'refuse'
export const CONFIG_REFUSED = 3
// The line the process answers each write with, followed by the exit code that write would have had: anything else it prints is not an answer.
export const ANSWER = 'kay-types:'
// The line it says before each answer: the server entry the config it wrote the tree from names, as an absolute path.
export const ENTRY = 'kay-entry:'
// The line it says before each answer too: the project's modules it has loaded, as a JSON array of absolute paths, which an edit to starts a new process.
export const MODULES = 'kay-modules:'
// The lines `kay dev` sends the process writing the types: `load` reads the config and answers whether it did not load, so the first server need not wait for the tree, and `write` writes the tree.
export const LOAD = 'load'
export const WRITE = 'write'
// `check` types the project as `kay check` does and answers the type errors it found on a `kay-problems:` line before its exit code: 0 when it found none, 1 when it found some, 2 when it could not run because the config does not load.
export const CHECK = 'check'
export const PROBLEMS = 'kay-problems:'
export const CHECK_SKIPPED = 2

// One type error `kay dev` shows, at the `.kay` line the author wrote, from the project's root.
export interface TypeProblem {
  file: string
  line: number
  column: number
  code?: string | undefined
  message: string
  // The error as `kay check` prints it, code frame included.
  report: string
}
