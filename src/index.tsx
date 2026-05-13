#!/usr/bin/env bun
/** @jsxImportSource @opentui/react */
import { writeFileSync } from "node:fs"
import { useEffect, useMemo, useRef, useState } from "react"
import { createCliRenderer, fg, bold, t, StyledText, type BoxRenderable, type ScrollBoxRenderable, type TextareaRenderable, type TextChunk } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer } from "@opentui/react"
import { useSelector } from "@xstate/react"
import { createActor, type ActorRefFrom } from "xstate"
import nightOwl from 'tm-themes/themes/github-dark.json'
import { textMateThemeToDiffTheme } from "./theme-mapper"
import { reviewMachine, type ReviewComment } from "./review-machine"
import { availableAgents, dispatchReviewFix, listProviderModels, type AgentId, type AgentProviderModelOption } from "./agents"
import { startDiffHighlightWorker, type DiffHighlightWorkerClient } from "./diff-highlight-worker-client"
import { EMPTY_PARSED_DIFF_STATE, buildTerminalDiffRows, diffMetadataCacheKey, getDiffLineTypes, highlightedDiffCache, maxLineNumber, maxTerminalDiffContentScroll, parseDiffMetadata, renderTerminalDiffRow, type LineColor, type ParsedDiffState } from "./diff-rendering"

interface ChangedFile {
  path: string
  status: string
}

interface CliOptions {
  outputPath: string | null
}

function parseCliOptions(argv: string[]): CliOptions {
  let outputPath: string | null = null

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--output" || arg === "-o") {
      outputPath = argv[++index] ?? null
      continue
    }
    if (arg.startsWith("--output=")) {
      outputPath = arg.slice("--output=".length)
      continue
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: revy [--output <comments.json>]")
      process.exit(0)
    }
  }

  return { outputPath }
}

const cliOptions = parseCliOptions(Bun.argv.slice(2))
let gitCwd = process.cwd()

function collectReviewComments(commentsByFile: Record<string, ReviewComment[]>): Array<Omit<ReviewComment, "createdAt"> & { createdAt: string }> {
  return Object.values(commentsByFile)
    .flat()
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.diffStartLine - b.diffStartLine || a.createdAt - b.createdAt)
    .map((comment) => ({
      id: comment.id,
      filePath: comment.filePath,
      diffStartLine: comment.diffStartLine,
      diffEndLine: comment.diffEndLine,
      body: comment.body,
      createdAt: new Date(comment.createdAt).toISOString(),
    }))
}

function writeReviewComments(outputPath: string, commentsByFile: Record<string, ReviewComment[]>, repoRoot: string): void {
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        version: 1,
        repoRoot,
        comments: collectReviewComments(commentsByFile),
      },
      null,
      2,
    ) + "\n",
  )
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: gitCwd, stdout: "pipe", stderr: "pipe" })
  if (!result.success) {
    const message = new TextDecoder().decode(result.stderr).trim()
    throw new Error(message || `git ${args.join(" ")} failed`)
  }
  return new TextDecoder().decode(result.stdout)
}

function gitDiff(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: gitCwd, stdout: "pipe", stderr: "pipe" })
  const stdout = new TextDecoder().decode(result.stdout)
  if (!result.success && stdout.length === 0) {
    const message = new TextDecoder().decode(result.stderr).trim()
    throw new Error(message || `git ${args.join(" ")} failed`)
  }
  return stdout
}

function loadChangedFiles(): ChangedFile[] {
  const output = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  const entries = output.split("\0").filter(Boolean)
  const files: ChangedFile[] = []

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    const status = entry.slice(0, 2).trim() || "M"
    const path = entry.slice(3)
    if (!path) continue

    files.push({ status, path })

    // In porcelain v1 -z output, renames/copies are encoded as:
    // "XY new-path\0old-path\0". The diff should be loaded for new-path.
    if (status.includes("R") || status.includes("C")) index++
  }

  return files
}

function loadDiff(file: ChangedFile): string {
  if (file.status === "??") {
    return gitDiff(["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file.path])
  }

  return gitDiff(["diff", "--no-color", "--no-ext-diff", "HEAD", "--", file.path])
}

function fuzzyMatches(value: string, query: string): boolean {
  let valueIndex = 0
  const normalizedValue = value.toLowerCase()
  const normalizedQuery = query.toLowerCase().trim()

  for (const char of normalizedQuery) {
    valueIndex = normalizedValue.indexOf(char, valueIndex)
    if (valueIndex === -1) return false
    valueIndex++
  }

  return true
}

const codingTheme = textMateThemeToDiffTheme(nightOwl)
const codingThemeColors = nightOwl.colors ?? {}

const theme = {
  backgroundColor: codingTheme.backgroundColor,
  panelColor: codingThemeColors["sideBar.background"] ?? codingThemeColors["panel.background"] ?? codingTheme.backgroundColor,
  borderColor: codingThemeColors["panel.border"] ?? codingThemeColors.focusBorder ?? codingTheme.lineNumberFg,
  accent: codingThemeColors["terminal.ansiBlue"] ?? codingThemeColors["button.background"] ?? codingTheme.selectionBg,
  muted: codingThemeColors["sideBarTitle.foreground"] ?? codingTheme.lineNumberFg,
  fg: codingTheme.fg,
  addedSignColor: codingTheme.addedSignColor,
  removedSignColor: codingTheme.removedSignColor,
  modifiedSignColor: codingThemeColors["editorGutter.modifiedBackground"] ?? codingThemeColors["terminal.ansiYellow"] ?? codingTheme.addedSignColor,
}

function filenameColorForStatus(status: string): string {
  if (status === "??" || status.includes("A")) return theme.addedSignColor
  if (status.includes("D")) return theme.removedSignColor
  return theme.modifiedSignColor
}

function renderFileTree(files: ChangedFile[], selectedIndex: number, emptyMessage = "No changes found."): StyledText | string {
  if (files.length === 0) return emptyMessage

  const chunks: TextChunk[] = []
  files.forEach((file, index) => {
    const fileColor = filenameColorForStatus(file.status)
    chunks.push({ __isChunk: true, text: `${index === selectedIndex ? "›" : " "} ` })
    chunks.push(fg(fileColor)(`${file.status.padEnd(2)} `))
    chunks.push(fg(fileColor)(file.path))
    if (index < files.length - 1) chunks.push({ __isChunk: true, text: "\n" })
  })
  return new StyledText(chunks)
}

function App({ diffHighlightWorker, reviewActor }: { diffHighlightWorker: DiffHighlightWorkerClient; reviewActor: ActorRefFrom<typeof reviewMachine> }) {
  const renderer = useRenderer()
  const [files, setFiles] = useState<ChangedFile[]>(() => loadChangedFiles())
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [fileSearchQuery, setFileSearchQuery] = useState("")
  const [focusMode, setFocusMode] = useState<"tree" | "diff" | "comment" | "agent">("tree")
  const [diffScrollY, setDiffScrollY] = useState(0)
  const [diffScrollX, setDiffScrollX] = useState(0)
  const [currentDiffLine, setCurrentDiffLine] = useState(0)
  const [selectionAnchorLine, setSelectionAnchorLine] = useState<number | null>(null)
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0)
  const [selectedPickerAgent, setSelectedPickerAgent] = useState<AgentId>(availableAgents[0]?.id ?? "codex")
  const [agentSearchQuery, setAgentSearchQuery] = useState("")
  const [agentOptions, setAgentOptions] = useState<AgentProviderModelOption[]>([])
  const [agentOptionsStatus, setAgentOptionsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [agentRunStatus, setAgentRunStatus] = useState<"idle" | "running" | "done" | "error">("idle")
  const [agentRunMessage, setAgentRunMessage] = useState<string | null>(null)
  const [parsedDiff, setParsedDiff] = useState<ParsedDiffState>(EMPTY_PARSED_DIFF_STATE)
  const reviewState = useSelector(reviewActor, (snapshot) => snapshot)
  const sendReview = reviewActor.send
  const diffPanelRef = useRef<BoxRenderable | null>(null)
  const diffScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const commentTextareaRef = useRef<TextareaRenderable | null>(null)
  const diffTheme = codingTheme
  const isDraftingComment = reviewState.matches("draftingComment")
  const activeDraft = reviewState.context.draft

  useEffect(() => {
    diffHighlightWorker.enqueueFiles(files)
  }, [diffHighlightWorker, files])

  useEffect(() => {
    return diffHighlightWorker.subscribe(({ cacheKey, highlighted }) => {
      setParsedDiff((current) => {
        if (!current.metadata) return current
        if (diffMetadataCacheKey(current.metadata) !== cacheKey) return current
        return {
          metadata: current.metadata,
          highlighted,
          rows: buildTerminalDiffRows(current.metadata, highlighted, diffTheme),
          error: null,
        }
      })
    })
  }, [diffHighlightWorker, diffTheme])

  const visibleFiles = useMemo(
    () => files.filter((file) => fuzzyMatches(`${file.status} ${file.path}`, fileSearchQuery)),
    [files, fileSearchQuery],
  )
  const effectiveSelectedIndex = Math.max(0, Math.min(selectedIndex, visibleFiles.length - 1))
  const selected = visibleFiles[effectiveSelectedIndex]
  const diff = selected ? loadDiff(selected) : ""
  const hasPatch = diff.startsWith("diff --git") || diff.startsWith("--- ")
  const diffLineTypes = useMemo(() => getDiffLineTypes(diff), [diff])
  const diffLineCount = parsedDiff.rows.length || diffLineTypes.length
  const selectableDiffLineCount = parsedDiff.rows.filter((row) => row.type === "split-line").length || diffLineTypes.length
  const selectedRange = selectionAnchorLine === null
    ? null
    : {
      start: Math.min(selectionAnchorLine, currentDiffLine),
      end: Math.max(selectionAnchorLine, currentDiffLine),
    }

  useEffect(() => {
    if (!hasPatch) {
      setParsedDiff(EMPTY_PARSED_DIFF_STATE)
      return
    }

    let cancelled = false

    try {
      const metadata = parseDiffMetadata(diff, selected?.path ?? "diff")

      const cachedHighlight = highlightedDiffCache.get(diffMetadataCacheKey(metadata)) ?? null
      setParsedDiff({
        metadata,
        highlighted: cachedHighlight,
        rows: buildTerminalDiffRows(metadata, cachedHighlight, diffTheme),
        error: null,
      })

      if (!cachedHighlight) {
        void diffHighlightWorker.requestHighlight(selected?.path ?? "diff", diff)
          .then((highlighted) => {
            if (!cancelled) {
              setParsedDiff({
                metadata,
                highlighted,
                rows: buildTerminalDiffRows(metadata, highlighted, diffTheme),
                error: null,
              })
            }
          })
          .catch(() => {
            // Keep the immediate plain-text rows if highlighting fails.
          })
      }
    } catch (error) {
      setParsedDiff({ metadata: null, highlighted: null, rows: [], error: error instanceof Error ? error.message : String(error) })
    }

    return () => {
      cancelled = true
    }
  }, [diff, diffHighlightWorker, diffTheme, hasPatch, selected?.path])

  useEffect(() => {
    diffScrollRef.current?.scrollTo(diffScrollY)
  }, [diffScrollY])

  useEffect(() => {
    if (focusMode !== "diff" || diffLineCount === 0 || isSelectableDiffLine(currentDiffLine)) return
    const firstLine = firstSelectableDiffLine()
    if (firstLine !== -1) {
      setCurrentDiffLine(firstLine)
      scrollToDiffLine(firstLine)
    }
  }, [currentDiffLine, diffLineCount, focusMode, parsedDiff.rows])

  function resetDiffState(): void {
    setDiffScrollY(0)
    setDiffScrollX(0)
    setCurrentDiffLine(0)
    setSelectionAnchorLine(null)
    setFocusMode("tree")
  }

  function selectFile(nextIndex: number): void {
    const clampedIndex = Math.max(0, Math.min(visibleFiles.length - 1, nextIndex))
    if (visibleFiles[clampedIndex]?.path !== selected?.path) resetDiffState()
    setSelectedIndex(clampedIndex)
  }

  function getDiffViewportHeight(): number {
    const scrollViewportHeight = diffScrollRef.current?.viewport.height ?? 0
    if (scrollViewportHeight > 0) return scrollViewportHeight

    const panelHeight = diffPanelRef.current?.height ?? 0
    if (panelHeight > 2) return panelHeight - 2

    return Math.max(1, (renderer?.terminalHeight ?? 24) - 5)
  }

  function getDiffViewportWidth(): number {
    const scrollViewportWidth = diffScrollRef.current?.viewport.width ?? 0
    if (scrollViewportWidth > 0) return scrollViewportWidth
    return diffContentWidth
  }

  function isSelectableDiffLine(index: number): boolean {
    const row = parsedDiff.rows[index]
    return row ? row.type === "split-line" : diffLineTypes.length > 0 && index >= 0 && index < diffLineTypes.length
  }

  function firstSelectableDiffLine(): number {
    const rowIndex = parsedDiff.rows.findIndex((row) => row.type === "split-line")
    if (rowIndex !== -1) return rowIndex
    return diffLineTypes.length > 0 ? 0 : -1
  }

  function selectableDiffLineOrdinal(index: number): number {
    if (parsedDiff.rows.length === 0) return diffLineTypes.length === 0 ? 0 : index + 1
    return parsedDiff.rows.slice(0, index + 1).filter((row) => row.type === "split-line").length
  }

  function findSelectableDiffLine(from: number, delta: number): number {
    if (diffLineCount === 0 || delta === 0) return from

    const direction = delta > 0 ? 1 : -1
    let nextLine = from
    for (let remaining = Math.abs(delta); remaining > 0; remaining--) {
      let candidate = nextLine
      do {
        candidate += direction
        if (candidate < 0 || candidate >= diffLineCount) return nextLine
      } while (!isSelectableDiffLine(candidate))
      nextLine = candidate
    }
    return nextLine
  }

  function scrollToDiffLine(nextLine: number, viewportHeight = getDiffViewportHeight()): void {
    setDiffScrollY((scrollY) => {
      if (nextLine < scrollY) return nextLine
      if (nextLine >= scrollY + viewportHeight) return nextLine - viewportHeight + 1
      return scrollY
    })
  }

  function focusFirstSelectableDiffLine(): void {
    const firstLine = firstSelectableDiffLine()
    setCurrentDiffLine(firstLine === -1 ? 0 : firstLine)
    setDiffScrollY(0)
    setDiffScrollX(0)
    setSelectionAnchorLine(null)
  }

  function moveDiffCursor(delta: number, extendSelection = false): void {
    if (diffLineCount === 0) return
    const viewportHeight = getDiffViewportHeight()

    setCurrentDiffLine((line) => {
      if (extendSelection) setSelectionAnchorLine((anchor) => anchor ?? line)
      else setSelectionAnchorLine(null)

      const startLine = isSelectableDiffLine(line) ? line : firstSelectableDiffLine()
      if (startLine === -1) return line
      const nextLine = findSelectableDiffLine(startLine, delta)
      scrollToDiffLine(nextLine, viewportHeight)
      return nextLine
    })
  }

  function moveDiffHorizontally(delta: number): void {
    setDiffScrollX((scrollX) => Math.max(0, Math.min(diffMaxScrollX, scrollX + delta)))
  }

  function findCommentForLine(filePath: string, line: number): ReviewComment | undefined {
    return (reviewState.context.commentsByFile[filePath] ?? []).find(
      (comment) => line >= comment.diffStartLine && line <= comment.diffEndLine,
    )
  }

  useEffect(() => {
    if (focusMode !== "agent" || agentOptionsStatus !== "idle") return

    let cancelled = false
    setAgentOptionsStatus("loading")
    listProviderModels(gitCwd)
      .then((options) => {
        if (cancelled) return
        setAgentOptions(options)
        setSelectedAgentIndex(0)
        setAgentOptionsStatus("ready")
      })
      .catch((error) => {
        if (cancelled) return
        setAgentOptions([])
        setAgentOptionsStatus("error")
        setAgentRunStatus("error")
        setAgentRunMessage(error instanceof Error ? error.message : String(error))
      })

    return () => {
      cancelled = true
    }
  }, [agentOptionsStatus, focusMode])

  async function runFixAgent(option: AgentProviderModelOption): Promise<void> {
    const comments = Object.values(reviewState.context.commentsByFile).flat().map((comment) => ({
      id: comment.id,
      filePath: comment.filePath,
      diffStartLine: comment.diffStartLine,
      diffEndLine: comment.diffEndLine,
      body: comment.body,
    }))
    if (comments.length === 0) {
      setAgentRunStatus("error")
      setAgentRunMessage("No review comments to fix.")
      return
    }

    setFocusMode("diff")
    setAgentRunStatus("running")
    setAgentRunMessage(`Running ${option.agentLabel} with ${option.provider.label}/${option.model.label}...`)

    try {
      await dispatchReviewFix({
        agent: option.agent,
        repoRoot: gitCwd,
        comments,
        provider: option.provider.id,
        model: option.model.id,
      })
      setAgentRunStatus("done")
      setAgentRunMessage(`${option.agentLabel} finished. Cleared review comments and refreshed git status.`)
      sendReview({ type: "review.reset" })
      refresh()
    } catch (error) {
      setAgentRunStatus("error")
      setAgentRunMessage(error instanceof Error ? error.message : String(error))
    }
  }

  function refresh(): void {
    const nextFiles = loadChangedFiles()
    const nextVisibleFiles = nextFiles.filter((file) => fuzzyMatches(`${file.status} ${file.path}`, fileSearchQuery))
    const nextIndex = Math.max(0, Math.min(effectiveSelectedIndex, nextVisibleFiles.length - 1))
    if (nextVisibleFiles[nextIndex]?.path !== selected?.path) resetDiffState()
    setFiles(nextFiles)
    setSelectedIndex(nextIndex)
  }

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) renderer?.destroy()
    if (key.name === "r") refresh()

    if (key.ctrl && key.name === "s" && !isDraftingComment && agentRunStatus !== "running") {
      setFocusMode("agent")
      setAgentRunStatus("idle")
      setAgentRunMessage(null)
      setSelectedAgentIndex(0)
      setAgentSearchQuery("")
      if (agentOptionsStatus === "error") setAgentOptionsStatus("idle")
      return
    }

    if (key.name === "escape") {
      if (isDraftingComment) {
        sendReview({ type: "comment.cancel" })
        setFocusMode("diff")
      } else if (focusMode === "agent") {
        setFocusMode("diff")
      } else {
        setSelectionAnchorLine(null)
        setFocusMode("tree")
      }
      return
    }

    if (isDraftingComment || agentRunStatus === "running") return

    if (focusMode === "agent") {
      const numberKey = Number(key.name)
      if (Number.isInteger(numberKey) && numberKey >= 1 && numberKey <= availableAgents.length) {
        setSelectedPickerAgent(availableAgents[numberKey - 1]!.id)
        setSelectedAgentIndex(0)
        return
      }
      if (key.name === "backspace") {
        setAgentSearchQuery((query) => query.slice(0, -1))
        setSelectedAgentIndex(0)
        return
      }
      if (key.name === "down") {
        setSelectedAgentIndex((index) => Math.min(filteredAgentOptions.length - 1, index + 1))
        return
      }
      if (key.name === "up") {
        setSelectedAgentIndex((index) => Math.max(0, index - 1))
        return
      }
      if (key.name === "return" || key.name === "enter") {
        const option = filteredAgentOptions[selectedAgentIndex]
        if (option) void runFixAgent(option)
        return
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        setAgentSearchQuery((query) => query + key.sequence)
        setSelectedAgentIndex(0)
      }
      return
    }

    if (focusMode === "tree") {
      if ((key.name === "return" || key.name === "enter") && hasPatch) {
        focusFirstSelectableDiffLine()
        setFocusMode("diff")
        return
      }
      if (key.name === "backspace") {
        setFileSearchQuery((query) => query.slice(0, -1))
        setSelectedIndex(0)
        resetDiffState()
        return
      }
      if (key.ctrl && key.name === "u") {
        setFileSearchQuery("")
        setSelectedIndex(0)
        resetDiffState()
        return
      }
      if (key.name === "down" || key.name === "j") {
        selectFile(effectiveSelectedIndex + 1)
        return
      }
      if (key.name === "up" || key.name === "k") {
        selectFile(effectiveSelectedIndex - 1)
        return
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        setFileSearchQuery((query) => query + key.sequence)
        setSelectedIndex(0)
        resetDiffState()
      }
      return
    }

    if (key.name === "return" || key.name === "enter") {
      if (!selected) return
      const existingComment = findCommentForLine(selected.path, currentDiffLine)
      if (existingComment) {
        sendReview({ type: "comment.edit", comment: existingComment })
      } else {
        const range = selectedRange ?? { start: currentDiffLine, end: currentDiffLine }
        sendReview({ type: "comment.start", filePath: selected.path, startLine: range.start, endLine: range.end })
      }
      setFocusMode("comment")
      return
    }

    if (key.ctrl && key.name === "d") moveDiffCursor(Math.max(1, Math.floor(getDiffViewportHeight() / 2)))
    if (key.ctrl && key.name === "u") moveDiffCursor(-Math.max(1, Math.floor(getDiffViewportHeight() / 2)))
    if (key.name === "down" || key.name === "j") moveDiffCursor(1, key.shift)
    if (key.name === "up" || key.name === "k") moveDiffCursor(-1, key.shift)
    if (key.name === "right") moveDiffHorizontally(key.shift ? Math.max(1, Math.floor(getDiffViewportWidth() / 2)) : 8)
    if (key.name === "left") moveDiffHorizontally(key.shift ? -Math.max(1, Math.floor(getDiffViewportWidth() / 2)) : -8)
    if (key.name === "pagedown") moveDiffCursor(Math.max(1, getDiffViewportHeight() - 1))
    if (key.name === "pageup") moveDiffCursor(-Math.max(1, getDiffViewportHeight() - 1))
    if (key.name === "home") {
      focusFirstSelectableDiffLine()
    }
  })

  const tree = renderFileTree(visibleFiles, effectiveSelectedIndex, files.length === 0 ? "No changes found." : "No matching files.")
  const diffViewportHeight = getDiffViewportHeight()
  const commentRow = activeDraft === null || activeDraft.filePath !== selected?.path ? null : activeDraft.diffEndLine - diffScrollY
  const isCommentVisible = commentRow !== null && commentRow >= 0 && commentRow < diffViewportHeight
  const commentCount = Object.values(reviewState.context.commentsByFile).reduce((count, comments) => count + comments.length, 0)
  const filteredAgentOptions = agentOptions
    .filter((option) => option.agent === selectedPickerAgent)
    .filter((option) => fuzzyMatches(`${option.provider.label}/${option.model.label} ${option.provider.id}/${option.model.id}`, agentSearchQuery))
  const agentPickerHeight = Math.min(22, Math.max(14, (renderer?.terminalHeight ?? 24) - 4))
  const maxVisibleAgentOptions = Math.max(1, agentPickerHeight - 10)
  const visibleAgentOptionsStart = Math.max(0, Math.min(selectedAgentIndex - maxVisibleAgentOptions + 1, Math.max(0, filteredAgentOptions.length - maxVisibleAgentOptions)))
  const visibleAgentOptions = filteredAgentOptions.slice(visibleAgentOptionsStart, visibleAgentOptionsStart + maxVisibleAgentOptions)
  const agentList = agentOptionsStatus === "loading"
    ? "Loading provider models..."
    : agentOptionsStatus === "error"
      ? (agentRunMessage ?? "Failed to load provider models.")
      : filteredAgentOptions.length === 0
        ? "No provider models available."
        : visibleAgentOptions
          .map((option, index) => `${index + visibleAgentOptionsStart === selectedAgentIndex ? "›" : " "} ${option.provider.label}/${option.model.label}`)
          .join("\n")
  const agentTabs = availableAgents
    .map((agent, index) => `${agent.id === selectedPickerAgent ? "[" : " "}${index + 1} ${agent.label}${agent.id === selectedPickerAgent ? "]" : " "}`)
    .join("  ")
  const pierreOverlays = new Map<number, LineColor>()
  const draftRange = activeDraft && activeDraft.filePath === selected?.path
    ? { start: activeDraft.diffStartLine, end: activeDraft.diffEndLine }
    : null
  const highlightedRange = isDraftingComment ? draftRange : selectedRange
  const commentsForSelectedFile = selected ? reviewState.context.commentsByFile[selected.path] ?? [] : []
  for (const comment of commentsForSelectedFile) {
    for (let line = comment.diffStartLine; line <= comment.diffEndLine; line++) {
      pierreOverlays.set(line, { gutter: "#d29922", content: diffTheme.contextBg })
    }
  }
  if (highlightedRange) {
    for (let line = highlightedRange.start; line <= highlightedRange.end; line++) {
      pierreOverlays.set(line, { gutter: diffTheme.selectionBg, content: diffTheme.selectionBg })
    }
  } else if (focusMode === "diff" && diffLineCount > 0) {
    pierreOverlays.set(currentDiffLine, { gutter: diffTheme.activeLineNumberBg, content: diffTheme.activeLineBg })
  }
  const sidePanelWidth = Math.max(28, Math.floor((renderer?.terminalWidth ?? 100) * 0.28))
  const diffContentWidth = Math.max(30, (renderer?.terminalWidth ?? 100) - sidePanelWidth - 6)
  const lineNumberDigits = String(maxLineNumber(parsedDiff.metadata)).length
  const diffMaxScrollX = maxTerminalDiffContentScroll(parsedDiff.rows, lineNumberDigits, diffContentWidth)
  const currentSelectableDiffLine = selectableDiffLineOrdinal(currentDiffLine)

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.backgroundColor }}>
      <box
        title=" revy "
        style={{
          height: 3,
          flexShrink: 0,
          border: true,
          borderColor: theme.borderColor,
          backgroundColor: theme.panelColor,
          paddingLeft: 1,
          alignItems: "center",
        }}
      >
        <text
          content={t`${bold(fg(theme.accent)("revy"))} ${fg(theme.muted)(agentRunStatus === "running" ? agentRunMessage ?? "Running agent..." : focusMode === "agent" ? "agent: ↑/↓ choose • enter run • esc cancel" : focusMode === "tree" ? `tree: ↑/k ↓/j select • enter diff • ctrl+s fix • r refresh • q quit${cliOptions.outputPath ? " • writes comments on quit" : ""}` : `diff: line ${Math.min(currentSelectableDiffLine, selectableDiffLineCount)}/${selectableDiffLineCount} • ↑/↓ move • ←/→ pan • ctrl+d/u half-page • shift+↑/↓ select • enter comment • ctrl+s fix • esc tree • q quit`)}`}
        />
      </box>

      {agentRunMessage && focusMode !== "agent" ? (
        <box
          style={{
            position: "absolute",
            top: 1,
            right: 2,
            width: Math.min(58, Math.max(30, (renderer?.terminalWidth ?? 100) - 4)),
            height: 3,
            zIndex: 20,
            border: true,
            borderColor: agentRunStatus === "error" ? theme.removedSignColor : agentRunStatus === "done" ? theme.addedSignColor : theme.accent,
            backgroundColor: theme.panelColor,
            paddingLeft: 1,
            alignItems: "center",
          }}
        >
          <text content={t`${fg(agentRunStatus === "error" ? theme.removedSignColor : agentRunStatus === "done" ? theme.addedSignColor : theme.accent)(agentRunMessage)}`} />
        </box>
      ) : null}

      <box style={{ flexGrow: 1, flexDirection: "row", backgroundColor: theme.backgroundColor }}>
        <box
          ref={diffPanelRef}
          title={selected ? ` Diff: ${selected.path} ` : " Diff "}
          style={{
            flexGrow: 1,
            minWidth: 30,
            border: true,
            borderColor: focusMode === "diff" ? theme.accent : theme.borderColor,
            backgroundColor: diffTheme.backgroundColor,
          }}
        >
          {hasPatch ? (
            <>
              <scrollbox
                ref={diffScrollRef}
                scrollY={true}
                viewportCulling={true}
                focused={false}
                rootOptions={{ backgroundColor: diffTheme.backgroundColor }}
                wrapperOptions={{ backgroundColor: diffTheme.backgroundColor }}
                viewportOptions={{ backgroundColor: diffTheme.backgroundColor }}
                contentOptions={{ backgroundColor: diffTheme.backgroundColor }}
                verticalScrollbarOptions={{ visible: false }}
                horizontalScrollbarOptions={{ visible: false }}
                style={{ flexGrow: 1, flexShrink: 1 }}
              >
                <box style={{ width: "100%", flexDirection: "column", backgroundColor: diffTheme.backgroundColor }}>
                  {parsedDiff.error ? (
                    <text content={`Failed to render diff: ${parsedDiff.error}`} fg={diffTheme.fg} bg={diffTheme.backgroundColor} />
                  ) : parsedDiff.rows.length === 0 ? (
                    <text content="Rendering diff..." fg={diffTheme.fg} bg={diffTheme.backgroundColor} />
                  ) : parsedDiff.rows.map((row, index) => (
                    <box key={`diff-row:${index}`} style={{ width: "100%", height: 1, flexShrink: 0, backgroundColor: diffTheme.backgroundColor }}>
                      <text
                        content={renderTerminalDiffRow(row, index, lineNumberDigits, diffContentWidth, diffTheme, pierreOverlays, theme, diffScrollX)}
                        wrapMode="none"
                        truncate={true}
                      />
                    </box>
                  ))}
                </box>
              </scrollbox>

              {isCommentVisible ? (
                <box
                  title=" Comment "
                  style={{
                    position: "absolute",
                    top: Math.min((commentRow ?? 0) + 1, Math.max(1, diffViewportHeight - 9)),
                    left: 8,
                    right: 2,
                    height: 10,
                    zIndex: 10,
                    border: true,
                    borderColor: theme.accent,
                    backgroundColor: theme.panelColor,
                  }}
                >
                  <textarea
                    ref={commentTextareaRef}
                    key={activeDraft?.commentId ?? `${activeDraft?.filePath}:${activeDraft?.diffStartLine}:${activeDraft?.diffEndLine}`}
                    focused={isDraftingComment}
                    initialValue={activeDraft?.body ?? ""}
                    placeholder="Write a comment... (ctrl+enter saves, esc cancels)"
                    keyBindings={[
                      { name: "return", ctrl: true, action: "submit" },
                      { name: "enter", ctrl: true, action: "submit" },
                    ]}
                    backgroundColor={theme.panelColor}
                    textColor={theme.fg}
                    focusedBackgroundColor={theme.panelColor}
                    focusedTextColor={theme.fg}
                    onContentChange={() => {
                      sendReview({ type: "comment.updateDraft", body: commentTextareaRef.current?.plainText ?? "" })
                    }}
                    onSubmit={() => {
                      sendReview({ type: "comment.updateDraft", body: commentTextareaRef.current?.plainText ?? "" })
                      sendReview({ type: "comment.save" })
                      setFocusMode("diff")
                    }}
                    style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}
                  />
                </box>
              ) : null}
            </>
          ) : (
            <text content={selected ? "No textual diff for this file." : "No changes found."} />
          )}
        </box>

        <box
          style={{
            width: sidePanelWidth,
            flexShrink: 0,
            flexDirection: "column",
            backgroundColor: theme.panelColor,
          }}
        >
          <box
            title=" Search files "
            style={{
              height: 3,
              flexShrink: 0,
              border: true,
              borderColor: focusMode === "tree" ? theme.accent : theme.borderColor,
              backgroundColor: theme.panelColor,
              paddingLeft: 1,
              alignItems: "center",
            }}
          >
            <text content={fileSearchQuery ? t`${fileSearchQuery}${fg(theme.muted)("_")}` : t`${fg(theme.muted)("Type to filter files")}`} />
          </box>
          <scrollbox
            style={{ flexGrow: 1, flexShrink: 1 }}
            rootOptions={{ border: true, borderColor: focusMode === "tree" ? theme.accent : theme.borderColor, backgroundColor: theme.panelColor, title: ` Files ${visibleFiles.length}/${files.length} ` }}
            viewportOptions={{ backgroundColor: theme.panelColor }}
            contentOptions={{ backgroundColor: theme.panelColor, paddingLeft: 1 }}
          >
            <text content={tree} />
          </scrollbox>
        </box>
      </box>

      {focusMode === "agent" ? (
        <box
          title=" Fix with agent "
          style={{
            position: "absolute",
            top: Math.max(2, Math.floor((renderer?.terminalHeight ?? 24) / 2) - 10),
            left: Math.max(2, Math.floor((renderer?.terminalWidth ?? 100) / 2) - 40),
            width: Math.min(80, Math.max(48, (renderer?.terminalWidth ?? 100) - 4)),
            height: agentPickerHeight,
            zIndex: 30,
            border: true,
            borderColor: theme.accent,
            backgroundColor: theme.panelColor,
            flexDirection: "column",
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          <box style={{ height: 1, flexShrink: 0 }}>
            <text content={t`${fg(theme.muted)(`${commentCount} review comment${commentCount === 1 ? "" : "s"} will be sent.`)}`} />
          </box>
          <box style={{ height: 1, flexShrink: 0 }}>
            <text content={agentTabs} />
          </box>
          <box
            style={{
              height: 3,
              flexShrink: 0,
              border: true,
              borderColor: theme.borderColor,
              backgroundColor: theme.backgroundColor,
              paddingLeft: 1,
              alignItems: "center",
            }}
          >
            <text content={agentSearchQuery ? agentSearchQuery : t`${fg(theme.muted)("Fuzzy search for provider/model")}`} />
          </box>
          <box
            style={{
              flexGrow: 1,
              flexShrink: 1,
              minHeight: 3,
              border: true,
              borderColor: theme.borderColor,
              backgroundColor: theme.backgroundColor,
              paddingLeft: 1,
              paddingRight: 1,
            }}
          >
            <text content={agentList} />
          </box>
          <box style={{ height: 1, flexShrink: 0 }}>
            <text content={t`${fg(theme.muted)("1-9 switch agent • type search • ↑/↓ choose • enter run • esc cancel")}`} />
          </box>
        </box>
      ) : null}
    </box>
  )
}

try {
  git(["rev-parse", "--is-inside-work-tree"])
  gitCwd = git(["rev-parse", "--show-toplevel"]).trim() || process.cwd()
  const diffHighlightWorker = startDiffHighlightWorker({ cwd: gitCwd })
  const reviewActor = createActor(reviewMachine).start()
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    onDestroy: () => {
      diffHighlightWorker.dispose()
      const commentsByFile = reviewActor.getSnapshot().context.commentsByFile
      reviewActor.stop()
      if (!cliOptions.outputPath) return
      try {
        writeReviewComments(cliOptions.outputPath, commentsByFile, gitCwd)
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
      }
    },
  })
  renderer.setBackgroundColor(theme.backgroundColor)
  createRoot(renderer).render(<App diffHighlightWorker={diffHighlightWorker} reviewActor={reviewActor} />)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
