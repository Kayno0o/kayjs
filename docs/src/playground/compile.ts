import { compileKay, formatDiagnostic } from '../../../src/compiler'
import { StripError, stripTypes } from './strip'

export interface Problem {
  // 1-based, where the problem sits in the source, or 0 for one that has no line.
  line: number
  // The compiler's report: the message, then the line with its mark under the span.
  report: string
}

export interface Compiled {
  // Code of the component for the server's markup and for the browser's DOM, set when the source compiled without an error.
  server?: string | undefined
  dom?: string | undefined
  problems: Problem[]
}

const FILE = 'playground.kay'

function lineOf(source: string, offset: number): number {
  let line = 1

  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n')
      line++
  }

  return line
}

// One component in memory, as the build compiles it for the server and for the browser.
export function compile(source: string): Compiled {
  try {
    const options = { root: '/' }
    const server = compileKay(source, `/${FILE}`, { ...options, output: 'html' })
    const dom = compileKay(source, `/${FILE}`, { ...options, output: 'dom' })
    // Both outputs report the template and fence problems, so the second one's repeats are dropped.
    const diagnostics = [...server.diagnostics, ...dom.diagnostics.filter(diagnostic => !server.diagnostics.some(same => same.start === diagnostic.start && same.message === diagnostic.message))]
    const problems = diagnostics.map(diagnostic => ({ line: lineOf(source, diagnostic.start), report: formatDiagnostic(source, FILE, diagnostic) }))

    if (diagnostics.some(diagnostic => !diagnostic.checkOnly))
      return { problems }

    return { server: stripTypes(server.tsx), dom: stripTypes(dom.tsx), problems }
  }
  catch (error) {
    // A syntax error Babel found in the generated code, or what the stripper refuses: no line of the file to point at.
    return { problems: [{ line: 0, report: error instanceof Error && !(error instanceof StripError) ? `The generated code does not parse: ${error.message}` : String(error instanceof Error ? error.message : error) }] }
  }
}
