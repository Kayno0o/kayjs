import type { DocFile, DocMatch, DocSection } from '../docs-search'
import type { Command, ProblemFormat } from './command'
import { relative } from 'node:path'
import process from 'node:process'
import { explainError, isErrorCode } from '../compiler/errors'
import { explainLint, isLint } from '../compiler/lints'
import { docFiles, excerpt, findLabel, isLabel, labelPath, searchDocs } from '../docs-search'
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

    if (positionals.length === 1 && isLabel(files, first)) {
      const found = findLabel(files, first)
      const path = labelPath(first)

      if (found === undefined) {
        printFailure('docs', `\`${first}\` names no heading of \`${path}\`; \`kay docs ${path}\` lists them`, format)

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

    if (best === undefined) {
      printFailure('docs', `nothing matches \`${query}\`; \`kay docs\` lists the files`, format)

      return 1
    }

    const { section } = best
    const { text, omitted } = excerpt(best)

    printShown({ label: section.label, heading: section.heading, text, section, omitted, children: text === section.own ? section.children : [] }, rest.slice(0, OTHERS), format, root)

    return 0
  },
}

function printShown(shown: Shown, others: DocMatch[], format: ProblemFormat, root: string) {
  const { label, heading, text, section, omitted = 0, children = [] } = shown

  if (format === 'json') {
    printDocument({
      sections: [{ ...section === undefined ? { label } : where(section, root), heading, text, ...omitted > 0 && { omitted }, ...children.length > 0 && { children } }],
      others: others.map(match => ({ ...where(match.section, root), heading: match.section.heading })),
    })

    return
  }

  console.log([
    section === undefined ? label : `${label} (${relative(root, section.file.path)}:${section.line})`,
    '',
    text,
    ...omitted > 0 ? ['', `(${omitted} more blocks left out: \`kay docs ${label}\` prints the section whole)`] : [],
    ...children.length > 0 ? ['', 'Under it:', ...children.map(child => `  ${child}`)] : [],
    ...others.length > 0 ? ['', 'Also:', ...others.map(match => `  ${match.section.label}  ${match.section.heading}`)] : [],
  ].join('\n'))
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
