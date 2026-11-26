// French web law compliance checks (RGAA, RGPD, LCEN): static TSX/CSS warnings and route-level checks with explicit silencing.

import type { JSXAttribute, JSXAttributeItem, JSXChild, JSXElement, Node, Program } from 'oxc-parser'
import type { ModuleAnalysis } from './analyze'
import type { CompilerWarning } from './mistakes'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { visitorKeys } from 'oxc-parser'
import { relPosix, walkFiles } from '../build/files'
import { fileToRoutePath } from '../build/routes'
import { cleanJsxText, formatDiagnostic, formatLoc, isComponentTag, jsxTagName, unwrapParens, unwrapTsExpr } from './shared'

export type ComplianceRule =
  | 'rgaa/img-alt'
  | 'rgaa/form-label'
  | 'rgaa/accessible-name'
  | 'rgpd/third-party-url'
  | 'lcen/legal-notice'
  | 'rgaa/accessibility-statement'

export interface ComplianceConfig {
  /** Compliance rules to silence across the app. */
  ignore?: readonly ComplianceRule[] | undefined
  /** Set `true` for French public-sector sites (RGAA requires an accessibility statement page). */
  publicBody?: boolean | undefined
  /** Custom route path for the legal notice page, or `false` to silence `lcen/legal-notice`. */
  legalNotice?: string | false | undefined
}

const COMPLIANCE_RULES = new Set<ComplianceRule>([
  'rgaa/img-alt',
  'rgaa/form-label',
  'rgaa/accessible-name',
  'rgpd/third-party-url',
  'lcen/legal-notice',
  'rgaa/accessibility-statement',
])

const NON_LABELLED_INPUT_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image'])
const THIRD_PARTY_LINK_RELS = new Set(['stylesheet', 'preload', 'preconnect', 'dns-prefetch'])
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])
const DEFAULT_LEGAL_PATHS = new Set(['/mentions-legales', '/legal', '/legal-notice', '/imprint', '/impressum', '/cgu', '/cgv'])
const ACCESSIBILITY_PATHS = new Set(['/accessibilite', '/accessibility', '/declaration-accessibilite', '/accessibility-statement'])

const LINE_IGNORE_RE = /(?:^|[\s{;(,])\/\/\s*kay-ignore(-file)?[ \t]+([^\r\n]+)/g
const BLOCK_IGNORE_RE = /\/\*\s*kay-ignore(-file)?\s+([\s\S]*?)\*\//g
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(?:'([^']+)'|"([^"]+)"|([^'"\s);]+))/gi
const CSS_URL_RE = /url\(\s*(?:'([^']+)'|"([^"]+)"|([^'"\s)]+))\s*\)/gi

interface IgnoreMap {
  lineStarts: number[]
  fileRules: Set<ComplianceRule>
  lineRules: Map<number, Set<ComplianceRule>>
}

function buildLineStarts(code: string): number[] {
  const starts = [0]
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10)
      starts.push(i + 1)
  }
  return starts
}

function offsetToLine(lineStarts: readonly number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid]! <= offset)
      lo = mid
    else
      hi = mid - 1
  }
  return lo + 1
}

function extractRules(text: string): ComplianceRule[] {
  const out: ComplianceRule[] = []
  for (const token of text.trim().split(/[\s,]+/)) {
    if (COMPLIANCE_RULES.has(token as ComplianceRule))
      out.push(token as ComplianceRule)
  }
  return out
}

export function parseKayIgnores(code: string): IgnoreMap {
  const lineStarts = buildLineStarts(code)
  const fileRules = new Set<ComplianceRule>()
  const lineRules = new Map<number, Set<ComplianceRule>>()

  const record = (isFile: boolean, start: number, end: number, rawRules: string): void => {
    const rules = extractRules(rawRules)
    if (rules.length === 0)
      return
    if (isFile) {
      for (const r of rules)
        fileRules.add(r)
      return
    }
    const startLine = offsetToLine(lineStarts, start)
    const endLine = offsetToLine(lineStarts, end)
    for (const line of [startLine, endLine, endLine + 1]) {
      let set = lineRules.get(line)
      if (set === undefined) {
        set = new Set()
        lineRules.set(line, set)
      }
      for (const r of rules)
        set.add(r)
    }
  }

  for (const re of [LINE_IGNORE_RE, BLOCK_IGNORE_RE]) {
    re.lastIndex = 0
    for (let m = re.exec(code); m !== null; m = re.exec(code))
      record(m[1] === '-file', m.index, m.index + m[0].length, m[2]!)
  }
  return { lineStarts, fileRules, lineRules }
}

function isIgnoredAt(ignores: IgnoreMap, rule: ComplianceRule, offset: number): boolean {
  if (ignores.fileRules.has(rule))
    return true
  const line = offsetToLine(ignores.lineStarts, offset)
  return ignores.lineRules.get(line)?.has(rule) === true
}

export function isRuleIgnored(rule: ComplianceRule, compliance?: ComplianceConfig | undefined): boolean {
  if (rule === 'lcen/legal-notice' && compliance?.legalNotice === false)
    return true
  return compliance?.ignore?.includes(rule) === true
}

export function parseOrigin(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === '')
    return undefined
  try {
    return new URL(url.trim()).origin
  }
  catch {
    return undefined
  }
}

/** Returns the external origin when `rawUrl` points to a non-localhost third-party URL, or `undefined` otherwise. */
export function thirdPartyOrigin(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim()
  if (!/^(?:https?:)?\/\//i.test(trimmed))
    return undefined
  try {
    const parsed = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return undefined
    const host = parsed.hostname.toLowerCase()
    if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost'))
      return undefined
    return parsed.origin
  }
  catch {
    return undefined
  }
}

/** Whether a compiler warning should be surfaced given `compliance` and `site` config. */
export function shouldEmitWarning(warning: CompilerWarning, compliance?: ComplianceConfig | undefined, site?: string | undefined): boolean {
  if (warning.rule !== undefined && isRuleIgnored(warning.rule, compliance))
    return false
  if (warning.rule === 'rgpd/third-party-url' && warning.urlOrigin !== undefined) {
    const siteOrigin = parseOrigin(site)
    if (siteOrigin !== undefined && warning.urlOrigin === siteOrigin)
      return false
  }
  return true
}

function findAttr(attributes: readonly JSXAttributeItem[], name: string): JSXAttribute | undefined {
  for (const attr of attributes) {
    if (attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier' && attr.name.name === name)
      return attr
  }
  return undefined
}

function hasSpread(attributes: readonly JSXAttributeItem[]): boolean {
  return attributes.some(a => a.type === 'JSXSpreadAttribute')
}

function staticStringValueOf(value: JSXAttribute['value']): string | undefined {
  if (value === null)
    return undefined
  if (value.type === 'Literal' && typeof value.value === 'string')
    return value.value
  if (value.type === 'JSXExpressionContainer' && value.expression.type !== 'JSXEmptyExpression') {
    const expr = unwrapTsExpr(value.expression)
    if (expr.type === 'Literal' && typeof expr.value === 'string')
      return expr.value
    if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0)
      return expr.quasis[0]?.value.cooked ?? undefined
  }
  return undefined
}

function attrTargetKey(attr: JSXAttribute | undefined): string | undefined {
  if (attr === undefined || attr.value === null)
    return undefined
  const str = staticStringValueOf(attr.value)
  if (str !== undefined && str.trim() !== '')
    return `s:${str}`
  if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
    const expr = unwrapTsExpr(attr.value.expression)
    if (expr.type === 'Identifier')
      return `i:${expr.name}`
  }
  return undefined
}

function hasNonEmptyAttr(attributes: readonly JSXAttributeItem[], name: string): boolean {
  const attr = findAttr(attributes, name)
  if (attr === undefined || attr.value === null)
    return false
  const str = staticStringValueOf(attr.value)
  if (str !== undefined)
    return str.trim() !== ''
  if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
    const expr = unwrapParens(attr.value.expression)
    if (expr.type === 'Literal' && (expr.value === null || expr.value === false || expr.value === ''))
      return false
    if (expr.type === 'Identifier' && expr.name === 'undefined')
      return false
    return true
  }
  return false
}

function hasLabelAttr(attributes: readonly JSXAttributeItem[]): boolean {
  return hasNonEmptyAttr(attributes, 'aria-label')
    || hasNonEmptyAttr(attributes, 'aria-labelledby')
    || hasNonEmptyAttr(attributes, 'title')
}

function isAriaHidden(attributes: readonly JSXAttributeItem[]): boolean {
  const attr = findAttr(attributes, 'aria-hidden')
  if (attr === undefined)
    return false
  if (attr.value === null)
    return true
  if (attr.value.type === 'Literal')
    return attr.value.value === 'true'
  if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression') {
    const expr = unwrapParens(attr.value.expression)
    return expr.type === 'Literal' && (expr.value === true || expr.value === 'true')
  }
  return false
}

function hasMeaningfulExpression(expr: Node): boolean {
  const inner = unwrapParens(expr)
  if (inner.type === 'Literal')
    return typeof inner.value === 'string' ? inner.value.trim() !== '' : typeof inner.value === 'number'
  if (inner.type === 'Identifier' && inner.name === 'undefined')
    return false
  return true
}

function hasAccessibleName(children: readonly JSXChild[]): boolean {
  for (const child of children) {
    if (child.type === 'JSXText') {
      if (cleanJsxText(child.value).trim() !== '')
        return true
    }
    else if (child.type === 'JSXExpressionContainer') {
      if (child.expression.type !== 'JSXEmptyExpression' && hasMeaningfulExpression(child.expression))
        return true
    }
    else if (child.type === 'JSXFragment') {
      if (hasAccessibleName(child.children))
        return true
    }
    else if (child.type === 'JSXElement') {
      const attrs = child.openingElement.attributes
      if (isAriaHidden(attrs))
        continue
      const tag = jsxTagName(child.openingElement.name)
      if (hasSpread(attrs) || hasLabelAttr(attrs))
        return true
      if (tag === 'img') {
        if (hasNonEmptyAttr(attrs, 'alt'))
          return true
        continue
      }
      if (tag === 'svg') {
        const hasTitle = child.children.some(c =>
          c.type === 'JSXElement' && jsxTagName(c.openingElement.name) === 'title' && hasAccessibleName(c.children),
        )
        if (hasTitle)
          return true
        continue
      }
      if (isComponentTag(tag)) {
        if (hasNonEmptyAttr(attrs, 'label') || hasAccessibleName(child.children))
          return true
        continue
      }
      if (hasAccessibleName(child.children))
        return true
    }
  }
  return false
}

function walkAst(value: unknown, enter: (node: Node) => void, exit?: (node: Node) => void): void {
  if (value === null || typeof value !== 'object')
    return
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++)
      walkAst(value[i], enter, exit)
    return
  }
  const node = value as Node
  if (typeof node.type !== 'string')
    return
  enter(node)
  const keys = visitorKeys[node.type]
  if (keys !== undefined) {
    for (let i = 0; i < keys.length; i++)
      walkAst((node as unknown as Record<string, unknown>)[keys[i]!], enter, exit)
  }
  exit?.(node)
}

function collectLabelTargets(program: Program): Set<string> {
  const targets = new Set<string>()
  walkAst(program, (node) => {
    if (node.type !== 'JSXElement')
      return
    const tag = jsxTagName(node.openingElement.name)
    if (tag !== 'label')
      return
    const attrs = node.openingElement.attributes
    const key = attrTargetKey(findAttr(attrs, 'for') ?? findAttr(attrs, 'htmlFor'))
    if (key !== undefined)
      targets.add(key)
  })
  return targets
}

function checkThirdPartyElement(
  element: JSXElement,
  tag: string,
  filename: string,
  ignores: IgnoreMap,
  warnings: CompilerWarning[],
): void {
  const attrs = element.openingElement.attributes
  let attr: JSXAttribute | undefined
  let attrName = ''
  if (tag === 'script' || tag === 'iframe') {
    attr = findAttr(attrs, 'src')
    attrName = 'src'
  }
  else if (tag === 'link') {
    const relVal = staticStringValueOf(findAttr(attrs, 'rel')?.value ?? null)
    if (relVal === undefined)
      return
    const rels = relVal.toLowerCase().split(/\s+/)
    if (!rels.some(r => THIRD_PARTY_LINK_RELS.has(r)))
      return
    attr = findAttr(attrs, 'href')
    attrName = 'href'
  }
  if (attr === undefined)
    return
  const url = staticStringValueOf(attr.value)
  if (url === undefined)
    return
  const origin = thirdPartyOrigin(url)
  if (origin === undefined || isIgnoredAt(ignores, 'rgpd/third-party-url', attr.start))
    return
  warnings.push({
    rule: 'rgpd/third-party-url',
    urlOrigin: origin,
    start: attr.start,
    message: `[rgpd/third-party-url] <${tag} ${attrName}="${url}"> in ${filename} loads a third-party resource without consent: self-host it (e.g. @kayjs/seo fonts or public/) or wrap it in <ConsentGate category="...">.`,
  })
}

function checkJsxElementCompliance(
  element: JSXElement,
  filename: string,
  inLabel: boolean,
  inConsentGate: boolean,
  labelTargets: ReadonlySet<string>,
  ignores: IgnoreMap,
  warnings: CompilerWarning[],
): void {
  const tag = jsxTagName(element.openingElement.name)
  if (tag === '' || isComponentTag(tag))
    return
  const attrs = element.openingElement.attributes
  const spread = hasSpread(attrs)

  if (tag === 'img' && !spread && findAttr(attrs, 'alt') === undefined && !isIgnoredAt(ignores, 'rgaa/img-alt', element.start)) {
    warnings.push({
      rule: 'rgaa/img-alt',
      start: element.start,
      message: `[rgaa/img-alt] <img> in ${filename} is missing an alt attribute: add alt="description" or alt="" for decorative images.`,
    })
  }

  if ((tag === 'input' || tag === 'select' || tag === 'textarea') && !spread && !inLabel && !hasLabelAttr(attrs)) {
    const inputType = tag === 'input' ? staticStringValueOf(findAttr(attrs, 'type')?.value ?? null)?.toLowerCase() : undefined
    const idKey = attrTargetKey(findAttr(attrs, 'id'))
    const linked = idKey !== undefined && labelTargets.has(idKey)
    if ((inputType === undefined || !NON_LABELLED_INPUT_TYPES.has(inputType)) && !linked && !isIgnoredAt(ignores, 'rgaa/form-label', element.start)) {
      warnings.push({
        rule: 'rgaa/form-label',
        start: element.start,
        message: `[rgaa/form-label] <${tag}> in ${filename} has no associated label: wrap it in <label>, link <label for="id">, or add aria-label="..." / aria-labelledby="...".`,
      })
    }
  }

  if ((tag === 'button' || tag === 'a') && !spread && !hasLabelAttr(attrs) && !hasAccessibleName(element.children) && !isIgnoredAt(ignores, 'rgaa/accessible-name', element.start)) {
    warnings.push({
      rule: 'rgaa/accessible-name',
      start: element.start,
      message: `[rgaa/accessible-name] <${tag}> in ${filename} has no accessible name: add visible text or aria-label="...".`,
    })
  }

  if (!inConsentGate)
    checkThirdPartyElement(element, tag, filename, ignores, warnings)
}

/** Runs RGAA & RGPD static JSX compliance checks on `program`, appending warnings (never throwing). */
export function checkCompliance(
  program: Program,
  filename: string,
  code: string,
  warnings: CompilerWarning[],
  resolveTag: (tag: string) => string | undefined,
): void {
  const ignores = parseKayIgnores(code)
  const labelTargets = collectLabelTargets(program)
  let labelDepth = 0
  let consentGateDepth = 0
  const labelFlags: boolean[] = []
  const consentFlags: boolean[] = []

  walkAst(
    program,
    (node) => {
      if (node.type !== 'JSXElement')
        return
      const tag = jsxTagName(node.openingElement.name)
      checkJsxElementCompliance(node, filename, labelDepth > 0, consentGateDepth > 0, labelTargets, ignores, warnings)
      const opensLabel = tag === 'label' || (isComponentTag(tag) && hasNonEmptyAttr(node.openingElement.attributes, 'label'))
      const opensConsentGate = resolveTag(tag) === 'ConsentGate'
      labelFlags.push(opensLabel)
      consentFlags.push(opensConsentGate)
      if (opensLabel)
        labelDepth++
      if (opensConsentGate)
        consentGateDepth++
    },
    (node) => {
      if (node.type !== 'JSXElement')
        return
      if (labelFlags.pop() === true)
        labelDepth--
      if (consentFlags.pop() === true)
        consentGateDepth--
    },
  )
}

/** Scans a CSS file for third-party `@import` or `url(...)` origins (RGPD), respecting `/* kay-ignore *\/` and config. */
export function checkCssCompliance(
  relFile: string,
  code: string,
  compliance?: ComplianceConfig | undefined,
  site?: string | undefined,
): string[] {
  if (isRuleIgnored('rgpd/third-party-url', compliance))
    return []
  const ignores = parseKayIgnores(code)
  if (ignores.fileRules.has('rgpd/third-party-url'))
    return []
  const siteOrigin = parseOrigin(site)

  const commentSpans: [number, number][] = []
  CSS_COMMENT_RE.lastIndex = 0
  for (let m = CSS_COMMENT_RE.exec(code); m !== null; m = CSS_COMMENT_RE.exec(code))
    commentSpans.push([m.index, m.index + m[0].length])
  const inComment = (offset: number): boolean => commentSpans.some(([s, e]) => offset >= s && offset < e)

  const seenUrls = new Set<string>()
  const out: string[] = []
  const recordUrl = (offset: number, rawUrl: string): void => {
    if (inComment(offset))
      return
    const key = `${offset}:${rawUrl}`
    if (seenUrls.has(key))
      return
    const origin = thirdPartyOrigin(rawUrl)
    if (origin === undefined || (siteOrigin !== undefined && origin === siteOrigin))
      return
    if (isIgnoredAt(ignores, 'rgpd/third-party-url', offset))
      return
    seenUrls.add(key)
    const loc = formatLoc(relFile, code, offset)
    out.push(formatDiagnostic(loc, `[rgpd/third-party-url] "${rawUrl}" in ${relFile} loads a third-party resource without consent: self-host it (e.g. @kayjs/seo fonts or public/) or gate it with <ConsentGate category="...">.`, 'warning'))
  }

  for (const re of [CSS_IMPORT_RE, CSS_URL_RE]) {
    re.lastIndex = 0
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const url = m[1] ?? m[2] ?? m[3]
      if (url !== undefined)
        recordUrl(m.index + m[0].indexOf(url), url)
    }
  }
  return out
}

function normalizePath(path: string): string {
  const trimmed = path.trim()
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1).toLowerCase() : withSlash.toLowerCase()
}

/** Checks project-level LCEN legal notice and RGAA accessibility statement routes. */
export function checkRouteCompliance(pageRoutePaths: readonly string[], compliance?: ComplianceConfig | undefined): string[] {
  if (pageRoutePaths.length === 0)
    return []
  const normalized = new Set(pageRoutePaths.map(normalizePath))
  const out: string[] = []

  if (!isRuleIgnored('lcen/legal-notice', compliance)) {
    const custom = typeof compliance?.legalNotice === 'string' ? normalizePath(compliance.legalNotice) : undefined
    const hasLegal = custom !== undefined
      ? normalized.has(custom)
      : [...normalized].some(p => DEFAULT_LEGAL_PATHS.has(p))
    if (!hasLegal) {
      const expected = custom ?? '/mentions-legales (or /legal)'
      out.push(formatDiagnostic('kay.config.ts:1:1', `[lcen/legal-notice] App has no legal notice route: add ${expected}, set compliance.legalNotice, or silence with compliance: { legalNotice: false }.`, 'warning'))
    }
  }

  if (compliance?.publicBody === true && !isRuleIgnored('rgaa/accessibility-statement', compliance)) {
    const hasA11y = [...normalized].some(p => ACCESSIBILITY_PATHS.has(p))
    if (!hasA11y) {
      out.push(formatDiagnostic('kay.config.ts:1:1', '[rgaa/accessibility-statement] Public-body site (compliance.publicBody: true) has no accessibility statement route: add /accessibilite (or /accessibility).', 'warning'))
    }
  }

  return out
}

export interface ProjectComplianceInput {
  root: string
  srcDir: string
  routesDir: string
  routeFiles: readonly string[]
  analyses: ReadonlyMap<string, ModuleAnalysis>
  compliance?: ComplianceConfig | undefined
  site?: string | undefined
}

/** Collects project-level CSS third-party URL warnings and LCEN/RGAA route warnings for `kay check` and production `kay build`. */
export function collectProjectComplianceWarnings(input: ProjectComplianceInput): string[] {
  const { root, srcDir, routesDir, routeFiles, analyses, compliance, site } = input
  const warnings: string[] = []

  if (existsSync(srcDir)) {
    const cssFiles = walkFiles(srcDir, {
      skipDir: name => name === 'node_modules' || name === 'dist' || name.startsWith('.'),
      keep: entry => entry.name.endsWith('.css'),
    }).sort()
    for (const cssFile of cssFiles) {
      const code = readFileSync(cssFile, 'utf8')
      warnings.push(...checkCssCompliance(relPosix(root, cssFile), code, compliance, site))
    }
  }

  const pagePaths: string[] = []
  for (const file of routeFiles) {
    if (basename(file).startsWith('_'))
      continue
    const analysis = analyses.get(file)
    if (analysis !== undefined && analysis.exportedNames.includes('default'))
      pagePaths.push(fileToRoutePath(routesDir, file))
  }
  warnings.push(...checkRouteCompliance(pagePaths, compliance))
  return warnings
}
