// What `kay dev` and the process writing its types say to each other when a config that does not load stops the start.
export const REFUSE = 'refuse'
export const CONFIG_REFUSED = 3
// The line the process answers each write with, followed by the exit code that write would have had: anything else it prints is not an answer.
export const ANSWER = 'kay-types:'
// The line it says before each answer: the server entry the config it wrote the tree from names, as an absolute path.
export const ENTRY = 'kay-entry:'
// The lines `kay dev` sends the process writing the types: `load` reads the config and answers whether it did not load, so the first server need not wait for the tree, and `write` writes the tree.
export const LOAD = 'load'
export const WRITE = 'write'
