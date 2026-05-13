import { fg, parseColor, t, StyledText, type TextChunk } from "@opentui/core"
import { getFiletypeFromFileName, processPatch, type FileDiffMetadata } from "@pierre/diffs"

export type DiffLineType = "add" | "remove" | "context"
export type LineColor = { gutter: string; content: string }
export type RenderSpan = { text: string; fg?: string; bg?: string }

export type DiffTheme = {
  backgroundColor: string
  fg: string
  addedBg: string
  removedBg: string
  contextBg: string
  addedLineNumberBg: string
  removedLineNumberBg: string
  lineNumberBg: string
  addedSignColor: string
  removedSignColor: string
  lineNumberFg: string
  selectionBg: string
  activeLineNumberBg: string
  activeLineBg: string
}

export type DiffRowUiTheme = {
  accent: string
  muted: string
  borderColor: string
}

type HastNode = {
  type: "text" | "element"
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

export type HighlightedDiffCode = {
  deletionLines: Array<HastNode | undefined>
  additionLines: Array<HastNode | undefined>
}

type SplitCell = {
  kind: "context" | "addition" | "deletion" | "empty"
  sign: " " | "+" | "-"
  lineNumber?: number
  text: string
  spans: RenderSpan[]
}

export type TerminalDiffRow =
  | { type: "collapsed" | "hunk-header"; text: string }
  | { type: "split-line"; left: SplitCell; right: SplitCell }

export type ParsedDiffState = {
  metadata: FileDiffMetadata | null
  rows: TerminalDiffRow[]
  error: string | null
  highlighted: HighlightedDiffCode | null
}

export const EMPTY_PARSED_DIFF_STATE: ParsedDiffState = { metadata: null, rows: [], error: null, highlighted: null }
export const highlightedDiffCache = new Map<string, HighlightedDiffCode>()
const parsedDiffMetadataCache = new Map<string, FileDiffMetadata>()
const terminalRowsCache = new WeakMap<FileDiffMetadata, WeakMap<object, WeakMap<DiffTheme, TerminalDiffRow[]>>>()
const plainRowsCacheKey = {}
const parsedStyleCache = new Map<string, Record<string, string>>()
const flattenedLineCache = new WeakMap<HastNode, Map<string, RenderSpan[]>>()
export function getDiffLineTypes(diff: string): DiffLineType[] {
  return diff
    .split("\n")
    .filter((line) => !line.startsWith("diff --git") && !line.startsWith("index ") && !line.startsWith("--- ") && !line.startsWith("+++ ") && !line.startsWith("@@"))
    .flatMap((line) => {
      if (line.startsWith("+")) return ["add" as const]
      if (line.startsWith("-")) return ["remove" as const]
      if (line.startsWith(" ")) return ["context" as const]
      return []
    })
}

function cleanDiffLine(line: string | undefined): string {
  return (line ?? "").replace(/\n$/, "").replaceAll("\t", "  ")
}

function parseInlineStyle(style: unknown): Record<string, string> {
  if (typeof style !== "string") return {}
  const cached = parsedStyleCache.get(style)
  if (cached) return cached

  const result: Record<string, string> = {}
  for (const segment of style.split(";")) {
    const separator = segment.indexOf(":")
    if (separator <= 0) continue
    const key = segment.slice(0, separator).trim()
    const value = segment.slice(separator + 1).trim()
    if (key && value) result[key] = value
  }
  parsedStyleCache.set(style, result)
  return result
}

function flattenHighlightedLine(node: HastNode | undefined, emphasisBg: string): RenderSpan[] {
  if (!node) return []
  const cachedByBg = flattenedLineCache.get(node)
  const cached = cachedByBg?.get(emphasisBg)
  if (cached) return cached

  const spans: RenderSpan[] = []
  function push(span: RenderSpan): void {
    if (span.text.length === 0) return
    const previous = spans[spans.length - 1]
    if (previous && previous.fg === span.fg && previous.bg === span.bg) previous.text += span.text
    else spans.push(span)
  }

  function visit(current: HastNode | undefined, inherited: Pick<RenderSpan, "fg" | "bg">): void {
    if (!current) return
    if (current.type === "text") {
      push({ text: cleanDiffLine(current.value), fg: inherited.fg, bg: inherited.bg })
      return
    }

    const properties = current.properties ?? {}
    const styles = parseInlineStyle(properties.style)
    const next = {
      fg: styles["--diffs-token-dark"] ?? styles.color ?? inherited.fg,
      bg: Object.hasOwn(properties, "data-diff-span") ? emphasisBg : inherited.bg,
    }
    for (const child of current.children ?? []) visit(child, next)
  }

  visit(node, {})
  const nextCachedByBg = cachedByBg ?? new Map<string, RenderSpan[]>()
  nextCachedByBg.set(emphasisBg, spans)
  if (!cachedByBg) flattenedLineCache.set(node, nextCachedByBg)
  return spans
}

function makeSplitCell(kind: SplitCell["kind"], lineNumber: number | undefined, text: string | undefined, highlightedLine: HastNode | undefined, diffTheme: DiffTheme): SplitCell {
  return {
    kind,
    sign: kind === "addition" ? "+" : kind === "deletion" ? "-" : " ",
    lineNumber,
    text: kind === "empty" ? "" : cleanDiffLine(text),
    spans: kind === "empty" ? [] : flattenHighlightedLine(highlightedLine, kind === "addition" ? diffTheme.addedBg : kind === "deletion" ? diffTheme.removedBg : diffTheme.contextBg),
  }
}

function splitCellSpans(cell: SplitCell): RenderSpan[] {
  return cell.spans.length > 0 ? cell.spans : cell.text.length > 0 ? [{ text: cell.text }] : []
}

export function buildTerminalDiffRows(metadata: FileDiffMetadata, highlighted: HighlightedDiffCode | null, diffTheme: DiffTheme): TerminalDiffRow[] {
  const cacheKey = highlighted ?? plainRowsCacheKey
  const cachedByHighlight = terminalRowsCache.get(metadata)
  const cachedByTheme = cachedByHighlight?.get(cacheKey)
  const cached = cachedByTheme?.get(diffTheme)
  if (cached) return cached

  const rows: TerminalDiffRow[] = []

  for (const hunk of metadata.hunks) {
    if (hunk.collapsedBefore > 0) rows.push({ type: "collapsed", text: `${hunk.collapsedBefore} unmodified ${hunk.collapsedBefore === 1 ? "line" : "lines"}` })
    rows.push({ type: "hunk-header", text: hunk.hunkSpecs ?? "@@" })

    let deletionLineIndex = hunk.deletionLineIndex
    let additionLineIndex = hunk.additionLineIndex
    let deletionLineNumber = hunk.deletionStart
    let additionLineNumber = hunk.additionStart

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset++) {
          rows.push({
            type: "split-line",
            left: makeSplitCell("context", deletionLineNumber + offset, metadata.deletionLines[deletionLineIndex + offset], highlighted?.deletionLines[deletionLineIndex + offset], diffTheme),
            right: makeSplitCell("context", additionLineNumber + offset, metadata.additionLines[additionLineIndex + offset], highlighted?.additionLines[additionLineIndex + offset], diffTheme),
          })
        }
        deletionLineIndex += content.lines
        additionLineIndex += content.lines
        deletionLineNumber += content.lines
        additionLineNumber += content.lines
        continue
      }

      const pairedLines = Math.max(content.deletions, content.additions)
      for (let offset = 0; offset < pairedLines; offset++) {
        const hasDeletion = offset < content.deletions
        const hasAddition = offset < content.additions
        rows.push({
          type: "split-line",
          left: hasDeletion ? makeSplitCell("deletion", deletionLineNumber + offset, metadata.deletionLines[deletionLineIndex + offset], highlighted?.deletionLines[deletionLineIndex + offset], diffTheme) : makeSplitCell("empty", undefined, undefined, undefined, diffTheme),
          right: hasAddition ? makeSplitCell("addition", additionLineNumber + offset, metadata.additionLines[additionLineIndex + offset], highlighted?.additionLines[additionLineIndex + offset], diffTheme) : makeSplitCell("empty", undefined, undefined, undefined, diffTheme),
        })
      }

      deletionLineIndex += content.deletions
      additionLineIndex += content.additions
      deletionLineNumber += content.deletions
      additionLineNumber += content.additions
    }
  }

  const nextCachedByHighlight = cachedByHighlight ?? new WeakMap<object, WeakMap<DiffTheme, TerminalDiffRow[]>>()
  const nextCachedByTheme = cachedByTheme ?? new WeakMap<DiffTheme, TerminalDiffRow[]>()
  nextCachedByTheme.set(diffTheme, rows)
  if (!cachedByTheme) nextCachedByHighlight.set(cacheKey, nextCachedByTheme)
  if (!cachedByHighlight) terminalRowsCache.set(metadata, nextCachedByHighlight)
  return rows
}

export function maxLineNumber(metadata: FileDiffMetadata | null): number {
  if (!metadata) return 1
  let highest = 1
  for (const hunk of metadata.hunks) highest = Math.max(highest, hunk.deletionStart + hunk.deletionCount, hunk.additionStart + hunk.additionCount)
  return highest
}

function fitText(value: string, width: number): string {
  if (width <= 0) return ""
  if (value.length <= width) return value.padEnd(width)
  if (width === 1) return "…"
  return `${value.slice(0, width - 1)}…`
}

function fitSpans(spans: RenderSpan[], width: number): RenderSpan[] {
  if (width <= 0) return []
  const result: RenderSpan[] = []
  let remaining = width
  for (const span of spans) {
    if (remaining <= 0) break
    const text = span.text.length <= remaining ? span.text : span.text.slice(0, remaining)
    if (text.length > 0) result.push({ ...span, text })
    remaining -= text.length
  }
  if (remaining > 0) result.push({ text: " ".repeat(remaining) })
  return result
}

function splitCellColors(kind: SplitCell["kind"], diffTheme: DiffTheme): { gutterBg: string; contentBg: string; signFg: string } {
  if (kind === "addition") return { gutterBg: diffTheme.addedLineNumberBg, contentBg: diffTheme.addedBg, signFg: diffTheme.addedSignColor }
  if (kind === "deletion") return { gutterBg: diffTheme.removedLineNumberBg, contentBg: diffTheme.removedBg, signFg: diffTheme.removedSignColor }
  return { gutterBg: diffTheme.lineNumberBg, contentBg: diffTheme.contextBg, signFg: diffTheme.lineNumberFg }
}

function renderSplitCell(cell: SplitCell, width: number, digits: number, diffTheme: DiffTheme, overlay: LineColor | undefined): TextChunk[] {
  const colors = splitCellColors(cell.kind, diffTheme)
  const gutterBg = overlay?.gutter ?? colors.gutterBg
  const contentBg = overlay?.content ?? colors.contentBg
  const lineNumber = cell.lineNumber === undefined ? " ".repeat(digits) : String(cell.lineNumber).padStart(digits)
  const gutter = `${cell.sign} ${lineNumber} `
  const contentWidth = Math.max(0, width - gutter.length)
  return [
    { __isChunk: true, text: gutter, fg: parseColor(colors.signFg), bg: parseColor(gutterBg) },
    ...fitSpans(splitCellSpans(cell), contentWidth).map((span) => ({
      __isChunk: true as const,
      text: span.text,
      fg: parseColor(span.fg ?? diffTheme.fg),
      bg: parseColor(span.bg ?? contentBg),
    })),
  ]
}

export function renderTerminalDiffRow(row: TerminalDiffRow, index: number, digits: number, width: number, diffTheme: DiffTheme, overlays: Map<number, LineColor>, uiTheme: DiffRowUiTheme): StyledText {
  const overlay = overlays.get(index)
  if (row.type !== "split-line") {
    const color = row.type === "hunk-header" ? uiTheme.accent : uiTheme.muted
    return t`${fg(color)(fitText(row.text, width))}`
  }

  const separator = " │ "
  const sideWidth = Math.max(10, Math.floor((width - separator.length) / 2))
  return new StyledText([
    ...renderSplitCell(row.left, sideWidth, digits, diffTheme, overlay),
    { __isChunk: true, text: separator, fg: parseColor(uiTheme.borderColor), bg: parseColor(diffTheme.backgroundColor) },
    ...renderSplitCell(row.right, width - sideWidth - separator.length, digits, diffTheme, overlay),
  ])
}

export function diffMetadataCacheKey(metadata: FileDiffMetadata): string {
  return metadata.cacheKey ?? `${metadata.name}:${metadata.deletionLines.join("\n")}:${metadata.additionLines.join("\n")}`
}

export function parseDiffMetadata(diff: string, filePath: string): FileDiffMetadata {
  const cacheKey = `${filePath}\0${diff}`
  const cached = parsedDiffMetadataCache.get(cacheKey)
  if (cached) return cached

  const metadata = processPatch(diff, filePath).files[0]
  if (!metadata) throw new Error("Unable to parse diff")
  metadata.lang = getFiletypeFromFileName(metadata.name)
  parsedDiffMetadataCache.set(cacheKey, metadata)
  return metadata
}
