import { readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

type Schema = Record<string, unknown>

// What `kay build` and `kay dev` record in the output folder: the JSON Schema each tool action without an `output` answers, read from its handler's return type (src/check/tool-outputs.ts).
export const TOOL_OUTPUTS_RECORD = 'tool-outputs.json'

// An action by its file from the root, with `/` whatever the platform, and its export name.
export function toolOutputKey(root: string, file: string, name: string): string {
  return `${relative(root, file).split(sep).join('/')}#${name}`
}

export interface ToolOutputs {
  // The schema recorded for the action exported as `name` by `file`, none when the build could not describe its answer or recorded nothing.
  of: (file: string, name: string) => Schema | undefined
  // Changes whenever the record does, which `kay dev` rebuilds its tool list on.
  stamp: () => string
}

// What an executable holds of the record: fixed, as no build writes beside it.
export function recordedToolOutputs(root: string, outputs: Record<string, Schema>): ToolOutputs {
  return { of: (file, name) => outputs[toolOutputKey(root, file, name)], stamp: () => '' }
}

// The record of `output` as it is on disk, which an executable embeds.
export function readToolOutputs(output: string): Record<string, Schema> | undefined {
  try {
    return (JSON.parse(readFileSync(join(output, TOOL_OUTPUTS_RECORD), 'utf8')) as { outputs?: Record<string, Schema> }).outputs
  }
  catch {
    return undefined
  }
}

// The record of `output`, read again when the file changed: a server started from a build reads it once, and one under `kay dev` meets a newer one after an edit.
export function toolOutputsIn(root: string, output: string): ToolOutputs {
  const file = join(output, TOOL_OUTPUTS_RECORD)
  let seen = ''
  let outputs: Record<string, Schema> = {}

  const stamp = () => {
    const found = statSync(file, { throwIfNoEntry: false })

    return found === undefined ? '' : `${found.mtimeMs}:${found.size}`
  }
  const load = () => {
    const now = stamp()

    if (now === seen)
      return

    seen = now

    try {
      outputs = now === '' ? {} : (JSON.parse(readFileSync(file, 'utf8')) as { outputs?: Record<string, Schema> }).outputs ?? {}
    }
    catch {
      outputs = {}
    }
  }

  return {
    of: (path, name) => {
      load()

      return outputs[toolOutputKey(root, path, name)]
    },
    stamp,
  }
}
