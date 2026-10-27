import type { ComponentProps } from '../docs-props'
import type { DocFile, DocMatch, DocSection } from '../docs-search'
import type { Command, ProblemFormat } from './command'
import { relative } from 'node:path'
import process from 'node:process'
import { explainError, isErrorCode } from '../compiler/errors'
import { explainLint, isLint } from '../compiler/lints'
import { componentPlace, componentProps } from '../docs-props'
import { docFiles, excerpt, findLabel, isLabel, labelPath, looksLikeLabel, searchDocs } from '../docs-search'
import { formatOption, printDocument, printFailure } from './command'
import { USAGES } from './usages'

// The other matches a search lists after the one it prints.
const OTHERS = 5

interface Shown {
  label: string
  heading: string
  text: string
  section?: DocSection
  omitted?: number
  // The labels of the sections under it, when its text leaves them out.
  children?: string[]
}

// Lists the llms files of kay and the installed libraries, prints a file's headings or one section, or the section words match best.
export const docs: Command = {
  usage: USAGES.docs,
  options: { format: { type: 'string' } },
  positionals: Number.POSITIVE_INFINITY,
  run: ({ values, positionals }) => {
    const format = formatOption('docs', values.format)

    if (format === undefined)
      return 1

    const root = process.cwd()
    const files = docFiles(root)
    const [first] = positionals

    if (first === undefined) {
      if (format === 'json')
        printDocument({ files: files.map(file => ({ label: file.label, title: file.title, path: relative(root, file.path) })) })
      else
        console.log(files.map(file => `${file.label}  ${file.title}`).join('\n'))

      return 0
    }

    if (positionals.length === 1 && (isLabel(files, first) || looksLikeLabel(first))) {
      const found = findLabel(files, first)

      if (found === undefined) {
        printFailure('docs', missingLabel(files, first), format)

        return 1
      }

      if (found.section === undefined)
        printOutline(found.file, format, root)
      else
        printShown({ label: found.section.label, heading: found.section.heading, text: found.section.text, section: found.section }, [], format, root)

      return 0
    }

    const query = positionals.join(' ')
    const matches = searchDocs(files, query)

    // A lint or an error code is explained as `kay explain` does, the sections naming it listed after.
    if (positionals.length === 1 && (isLint(first) || isErrorCode(first))) {
      printShown({ label: `kay explain ${first}`, heading: first, text: isLint(first) ? explainLint(first) : explainError(first) }, matches.slice(0, OTHERS), format, root)

      return 0
    }

    const [best, ...rest] = matches
    const components = positionals.length === 1 ? componentProps(root, first) : []

    if (best === undefined && components.length === 0) {
      printFailure('docs', `nothing matches \`${query}\`; \`kay docs\` lists the files`, format)

      return 1
    }

    if (best === undefined) {
      printShown(undefined, [], format, root, components)

      return 0
    }

    const { section } = best
    const { text, omitted } = excerpt(best)

    printShown({ label: section.label, heading: section.heading, text, section, omitted, children: text === section.own ? section.children : [] }, rest.slice(0, OTHERS), format, root, components)

    return 0
  },
}

// The section, then the props of the components the word names, then the other matches.
function printShown(shown: Shown | undefined, others: DocMatch[], format: ProblemFormat, root: string, components: ComponentProps[] = []) {
  if (format === 'json') {
    printDocument({
      sections: shown === undefined ? [] : [shownDocument(shown, root)],
      ...components.length > 0 && { components: components.map(component => ({ name: component.name, import: component.specifier, path: relative(root, component.path), line: component.line, props: component.props })) },
      others: others.map(match => ({ ...where(match.section, root), heading: match.section.heading })),
    })

    return
  }

  const lines = shown === undefined ? [] : shownLines(shown, root)

  for (const component of components) {
    const place = `\`import ${component.name} from '${component.specifier}'\` (${componentPlace(component, root)})`

    lines.push(...lines.length > 0 ? [''] : [], ...component.props === '' ? [`${component.name} takes no props, ${place}`] : [`${component.name}'s props, ${place}:`, '', '```ts', component.props, '```'])
  }

  console.log([...lines, ...others.length > 0 ? ['', 'Also:', ...others.map(match => `  ${match.section.label}  ${match.section.heading}`)] : []].join('\n'))
}

function shownDocument({ label, heading, text, section, omitted = 0, children = [] }: Shown, root: string) {
  return { ...section === undefined ? { label } : where(section, root), heading, text, ...omitted > 0 && { omitted }, ...children.length > 0 && { children } }
}

function shownLines({ label, text, section, omitted = 0, children = [] }: Shown, root: string): string[] {
  return [
    section === undefined ? label : `${label} (${relative(root, section.file.path)}:${section.line})`,
    '',
    text,
    ...omitted > 0 ? ['', `(${omitted} more blocks left out: \`kay docs ${label}\` prints the section whole)`] : [],
    ...children.length > 0 ? ['', 'Under it:', ...children.map(child => `  ${child}`)] : [],
  ]
}

function printOutline(file: DocFile, format: ProblemFormat, root: string) {
  if (format === 'json')
    printDocument({ files: [{ label: file.label, title: file.title, path: relative(root, file.path), headings: file.sections.map(section => ({ ...where(section, root), heading: section.heading, level: section.level })) }] })
  else
    console.log([`${file.label} (${relative(root, file.path)})`, ...file.sections.map(section => `${'  '.repeat(section.level - 1)}${section.label}  ${section.heading}`)].join('\n'))
}

function where(section: DocSection, root: string) {
  return { label: section.label, path: relative(root, section.file.path), line: section.line }
}

// Why a label names nothing: a heading its file lacks, a file its package lacks, or a package not installed.
function missingLabel(files: DocFile[], label: string): string {
  const path = labelPath(label)

  if (findLabel(files, path) !== undefined)
    return `\`${label}\` names no heading of \`${path}\`; \`kay docs ${path}\` lists them`

  const bare = path.replace('@kaynooo/', '')
  const name = bare.slice(0, bare.indexOf('/'))

  return files.some(file => file.label.startsWith(`${name}/`))
    ? `\`${path}\` names no file of \`${name}\`; \`kay docs\` lists them`
    : `\`${name}\` is no package installed here with docs (a label is \`<package>/<file>.md#<heading>\`); \`kay docs\` lists the files of those that are`
}
