export interface FileEntry {
  name: string
  href?: string | undefined
  note?: string | undefined
  children: FileEntry[]
}

// An indent, the name or a Markdown link to the page about it, then a note after two spaces or more.
const LINE = /^(?<indent> *)(?:\[(?<linked>\S+?)\]\((?<href>[^)\s]+)\)|(?<name>\S+))(?: {2,}(?<note>\S.*))?$/

// A project tree written one file or folder per line, each nested two spaces under its folder, a folder's name ending in `/`.
export function fileTree(text: string): FileEntry[] {
  const lines = text.split('\n').map(line => line.trimEnd()).filter(line => line !== '')

  if (lines.length === 0)
    throw new Error('FileTree has no file to draw')

  const margin = Math.min(...lines.map(line => line.length - line.trimStart().length))
  const roots: FileEntry[] = []
  const open: { depth: number, children: FileEntry[] }[] = [{ depth: -1, children: roots }]

  for (const line of lines) {
    const groups = LINE.exec(line.slice(margin))?.groups

    if (!groups)
      throw new Error(`FileTree cannot read the line "${line.trim()}": a name or a [name](/page), then a note after two spaces`)

    const depth = groups.indent!.length
    const entry: FileEntry = { name: groups.linked ?? groups.name!, href: groups.href, note: groups.note, children: [] }

    while (open.at(-1)!.depth >= depth)
      open.pop()

    open.at(-1)!.children.push(entry)
    open.push({ depth, children: entry.children })
  }

  return roots
}
