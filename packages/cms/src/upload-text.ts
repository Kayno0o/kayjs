import { sizeText, wording } from 'kay/words'

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

// The least pixels a field asks of an image, as a sentence.
export function atLeast(width: number | undefined, height: number | undefined): string {
  if (width !== undefined && height !== undefined)
    return wording('cms.file.atLeast', 'At least {width} by {height} pixels.', { width, height })

  if (width !== undefined)
    return wording('cms.file.atLeastWide', 'At least {width} pixels wide.', { width })

  return wording('cms.file.atLeastHigh', 'At least {height} pixels high.', { height: height ?? 0 })
}

export function tooSmall(name: string, width: number, height: number, minWidth: number | undefined, minHeight: number | undefined): string {
  return wording('cms.upload.tooSmall', '{name} is {width} by {height} pixels. {need}', { name: fileName(name), width, height, need: atLeast(minWidth, minHeight) })
}

const KEY_SIZE = /\.(\d+)x(\d+)(?:-[\da-f]{6})?\.[a-z\d]{1,10}(?:\?.*)?$/i

// The width and height of an image kay's storage named a key or a URL for, which it reads off the file when it stores it; none for any other file.
export function sizeOfPath(path: string): { width: number, height: number } | undefined {
  const match = KEY_SIZE.exec(path)

  return match === null ? undefined : { width: Number(match[1]), height: Number(match[2]) }
}
