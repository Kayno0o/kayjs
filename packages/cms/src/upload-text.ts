const KB = 1024
const MB = 1024 * 1024

// `1 MB`, `512 KB`, as kay's own body-limit refusals say a size; imports nothing, since the editor's bundle shares it with the server.
function sizeText(bytes: number): string {
  if (bytes >= MB)
    return `${Number((bytes / MB).toFixed(1))} MB`

  return bytes >= KB ? `${Math.round(bytes / KB)} KB` : `${bytes} bytes`
}

// The words an editor, or a client skipping the editor, is told when a file is over what an upload may weigh; the one place the CMS's upload refusals are worded.
export function tooLarge(name: string, bytes: number, limit: number): string {
  return `${name || 'The file'} is ${sizeText(bytes)}, over the ${sizeText(limit)} an upload may be`
}

export function emptyFile(name: string): string {
  return `${name || 'The file'} is empty`
}
