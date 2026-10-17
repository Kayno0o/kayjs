import { wording } from 'kay/words'

const KB = 1024
const MB = 1024 * 1024

// `1 MB`, `512 KB`, as kay's own body-limit refusals say a size, the unit worded under `cms.size.*`.
function sizeText(bytes: number): string {
  if (bytes >= MB)
    return wording('cms.size.mb', '{size} MB', { size: Number((bytes / MB).toFixed(1)) })

  return bytes >= KB ? wording('cms.size.kb', '{size} KB', { size: Math.round(bytes / KB) }) : wording('cms.size.bytes', '{size} bytes', { size: bytes })
}

const fileName = (name: string): string => name || wording('cms.upload.theFile', 'The file')

// The words an editor, or a client skipping the editor, is told when a file is over what an upload may weigh; the one place the CMS's upload refusals are worded.
export function tooLarge(name: string, bytes: number, limit: number): string {
  return wording('cms.upload.tooLarge', '{name} is {size}, over the {limit} an upload may be', { name: fileName(name), size: sizeText(bytes), limit: sizeText(limit) })
}

export function emptyFile(name: string): string {
  return wording('cms.upload.empty', '{name} is empty', { name: fileName(name) })
}

// What a 413 from kay's body limit says, which only the editor can word with the file it sent.
export function tooLargeForServer(name: string, bytes: number): string {
  return wording('cms.upload.tooLargeForServer', '{name} is {size}, over what an upload may be', { name: fileName(name), size: sizeText(bytes) })
}
