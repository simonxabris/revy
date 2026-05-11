/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef, useState } from "react"
import { createCliRenderer, fg, bold, pathToFiletype, t, type DiffRenderable, type TextareaRenderable } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer } from "@opentui/react"
import { useMachine } from "@xstate/react"
import nightOwl from 'tm-themes/themes/night-owl.json'
import { shikiThemeToDiffTheme } from "./theme-mapper"
import { reviewMachine, type ReviewComment } from "./review-machine"

interface ChangedFile {
  path: string
  status: string
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" })
  if (!result.success) {
    const message = new TextDecoder().decode(result.stderr).trim()
    throw new Error(message || `git ${args.join(" ")} failed`)
  }
  return new TextDecoder().decode(result.stdout)
}

function loadChangedFiles(): ChangedFile[] {
  const output = git(["status", "--porcelain=v1"])
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || "M"
      const rawPath = line.slice(3).trim()
      const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath
      return { status, path: renamedPath ?? rawPath }
    })
}

function loadDiff(path: string): string {
  const staged = git(["diff", "--cached", "--", path])
  const unstaged = git(["diff", "--", path])
  return [staged, unstaged].filter(Boolean).join("\n")
}

function filetypeForDiffPath(path: string): string | undefined {
  const filetype = pathToFiletype(path)
  return filetype === "json" ? "javascript" : filetype
}

type DiffLineType = "add" | "remove" | "context"

function getDiffLineTypes(diff: string): DiffLineType[] {
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

const theme = {
  backgroundColor: "#0d1117",
  panelColor: "#161b22",
  borderColor: "#30363d",
  accent: "#58a6ff",
  muted: "#8b949e",
  fg: "#e6edf3",
  addedBg: "#1f3d2b",
  removedBg: "#4a2428",
  contextBg: "#0d1117",
  addedSignColor: "#3fb950",
  removedSignColor: "#f85149",
  lineNumberFg: "#6e7681",
  lineNumberBg: "#161b22",
  addedLineNumberBg: "#183a24",
  removedLineNumberBg: "#3d1f23",
  selectionBg: "#264f78",
  selectionFg: "#ffffff",
}


function App() {
  const renderer = useRenderer()
  const [files, setFiles] = useState<ChangedFile[]>(() => loadChangedFiles())
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [focusMode, setFocusMode] = useState<"tree" | "diff" | "comment">("tree")
  const [diffScrollY, setDiffScrollY] = useState(0)
  const [currentDiffLine, setCurrentDiffLine] = useState(0)
  const [selectionAnchorLine, setSelectionAnchorLine] = useState<number | null>(null)
  const [reviewState, sendReview] = useMachine(reviewMachine)
  const diffRef = useRef<DiffRenderable | null>(null)
  const commentTextareaRef = useRef<TextareaRenderable | null>(null)
  const diffTheme = useMemo(() => shikiThemeToDiffTheme(nightOwl as any), [])
  const isDraftingComment = reviewState.matches("draftingComment")
  const activeDraft = reviewState.context.draft

  const selected = files[selectedIndex]
  const diff = selected ? loadDiff(selected.path) : ""
  const hasPatch = diff.startsWith("diff --git") || diff.startsWith("--- ")
  const diffLineTypes = useMemo(() => getDiffLineTypes(diff), [diff])
  const diffLineCount = diffLineTypes.length
  const selectedRange = selectionAnchorLine === null
    ? null
    : {
      start: Math.min(selectionAnchorLine, currentDiffLine),
      end: Math.max(selectionAnchorLine, currentDiffLine),
    }

  useEffect(() => {
    const diffRenderable = diffRef.current as unknown as {
      leftCodeRenderable?: { scrollY: number }
      rightCodeRenderable?: { scrollY: number }
    } | null
    if (diffRenderable?.leftCodeRenderable) diffRenderable.leftCodeRenderable.scrollY = diffScrollY
    if (diffRenderable?.rightCodeRenderable) diffRenderable.rightCodeRenderable.scrollY = diffScrollY
    renderer?.requestRender()
  }, [diffScrollY, renderer])

  useEffect(() => {
    if (!hasPatch || !diffRef.current) return

    const lineColors = new Map<number, { gutter: string; content: string }>()
    diffLineTypes.forEach((type, index) => {
      if (type === "add") lineColors.set(index, { gutter: diffTheme.addedLineNumberBg, content: diffTheme.addedBg })
      else if (type === "remove") lineColors.set(index, { gutter: diffTheme.removedLineNumberBg, content: diffTheme.removedBg })
      else lineColors.set(index, { gutter: diffTheme.lineNumberBg, content: diffTheme.contextBg })
    })

    const draftRange = activeDraft && activeDraft.filePath === selected?.path
      ? { start: activeDraft.diffStartLine, end: activeDraft.diffEndLine }
      : null
    const highlightedRange = isDraftingComment ? draftRange : selectedRange
    const commentsForSelectedFile = selected ? reviewState.context.commentsByFile[selected.path] ?? [] : []
    for (const comment of commentsForSelectedFile) {
      for (let line = comment.diffStartLine; line <= comment.diffEndLine; line++) {
        const existing = lineColors.get(line)
        lineColors.set(line, { gutter: "#d29922", content: existing?.content ?? diffTheme.contextBg })
      }
    }

    if (highlightedRange) {
      for (let line = highlightedRange.start; line <= highlightedRange.end; line++) {
        lineColors.set(line, { gutter: diffTheme.selectionBg, content: diffTheme.selectionBg })
      }
    } else if (focusMode === "diff" && diffLineCount > 0) {
      lineColors.set(currentDiffLine, { gutter: diffTheme.activeLineNumberBg, content: diffTheme.activeLineBg })
    }

    diffRef.current.setLineColors(lineColors)
    renderer?.requestRender()
  }, [activeDraft, currentDiffLine, diffLineCount, diffLineTypes, diffTheme, focusMode, hasPatch, isDraftingComment, renderer, reviewState.context.commentsByFile, selected, selectedRange])

  function resetDiffState(): void {
    setDiffScrollY(0)
    setCurrentDiffLine(0)
    setSelectionAnchorLine(null)
    setFocusMode("tree")
  }

  function selectFile(nextIndex: number): void {
    const clampedIndex = Math.max(0, Math.min(files.length - 1, nextIndex))
    if (files[clampedIndex]?.path !== selected?.path) resetDiffState()
    setSelectedIndex(clampedIndex)
  }

  function moveDiffCursor(delta: number, extendSelection = false): void {
    if (diffLineCount === 0) return
    const viewportHeight = Math.max(1, (renderer?.terminalHeight ?? 24) - 5)

    setCurrentDiffLine((line) => {
      if (extendSelection) setSelectionAnchorLine((anchor) => anchor ?? line)
      else setSelectionAnchorLine(null)

      const nextLine = Math.max(0, Math.min(diffLineCount - 1, line + delta))
      setDiffScrollY((scrollY) => {
        if (nextLine < scrollY) return nextLine
        if (nextLine >= scrollY + viewportHeight) return nextLine - viewportHeight + 1
        return scrollY
      })
      return nextLine
    })
  }

  function findCommentForLine(filePath: string, line: number): ReviewComment | undefined {
    return (reviewState.context.commentsByFile[filePath] ?? []).find(
      (comment) => line >= comment.diffStartLine && line <= comment.diffEndLine,
    )
  }

  function refresh(): void {
    const nextFiles = loadChangedFiles()
    const nextIndex = Math.max(0, Math.min(selectedIndex, nextFiles.length - 1))
    if (nextFiles[nextIndex]?.path !== selected?.path) resetDiffState()
    setFiles(nextFiles)
    setSelectedIndex(nextIndex)
  }

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) renderer?.destroy()
    if (key.name === "r") refresh()

    if (key.name === "escape") {
      if (isDraftingComment) {
        sendReview({ type: "comment.cancel" })
        setFocusMode("diff")
      } else {
        setSelectionAnchorLine(null)
        setFocusMode("tree")
      }
      return
    }

    if (isDraftingComment) return

    if (focusMode === "tree") {
      if ((key.name === "return" || key.name === "enter") && hasPatch) {
        setFocusMode("diff")
        return
      }
      if (key.name === "down" || key.name === "j") {
        selectFile(selectedIndex + 1)
      }
      if (key.name === "up" || key.name === "k") {
        selectFile(selectedIndex - 1)
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

    if (key.name === "down" || key.name === "j") moveDiffCursor(1, key.shift)
    if (key.name === "up" || key.name === "k") moveDiffCursor(-1, key.shift)
    if (key.name === "pagedown") moveDiffCursor(Math.max(1, (renderer?.terminalHeight ?? 24) - 6))
    if (key.name === "pageup") moveDiffCursor(-Math.max(1, (renderer?.terminalHeight ?? 24) - 6))
    if (key.name === "home") {
      setSelectionAnchorLine(null)
      setCurrentDiffLine(0)
      setDiffScrollY(0)
    }
  })

  const tree = files.length
    ? files.map((file, index) => `${index === selectedIndex ? "›" : " "} ${file.status.padEnd(2)} ${file.path}`).join("\n")
    : "No changes found."
  const diffViewportHeight = Math.max(1, (renderer?.terminalHeight ?? 24) - 5)
  const commentRow = activeDraft === null || activeDraft.filePath !== selected?.path ? null : activeDraft.diffEndLine - diffScrollY
  const isCommentVisible = commentRow !== null && commentRow >= 0 && commentRow < diffViewportHeight

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
          content={t`${bold(fg(theme.accent)("revy"))} ${fg(theme.muted)(focusMode === "tree" ? "tree: ↑/k ↓/j select • enter diff • r refresh • q quit" : `diff: line ${Math.min(currentDiffLine + 1, diffLineCount)}/${diffLineCount} • ↑/↓ move • shift+↑/↓ select • enter comment • esc tree • q quit`)}`}
        />
      </box>

      <box style={{ flexGrow: 1, flexDirection: "row", backgroundColor: theme.backgroundColor }}>
        <box
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
              <diff
                ref={diffRef}
                diff={diff}
                view="unified"
                filetype={selected ? filetypeForDiffPath(selected.path) : undefined}
                syntaxStyle={diffTheme.syntaxStyle}
                showLineNumbers={true}
                wrapMode="none"
                fg={diffTheme.fg}
                addedBg={diffTheme.addedBg}
                removedBg={diffTheme.removedBg}
                contextBg={diffTheme.contextBg}
                addedSignColor={diffTheme.addedSignColor}
                removedSignColor={diffTheme.removedSignColor}
                lineNumberFg={diffTheme.lineNumberFg}
                lineNumberBg={diffTheme.lineNumberBg}
                addedLineNumberBg={diffTheme.addedLineNumberBg}
                removedLineNumberBg={diffTheme.removedLineNumberBg}
                selectionBg={diffTheme.selectionBg}
                selectionFg={diffTheme.selectionFg}
                style={{ flexGrow: 1, flexShrink: 1 }}
              />

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

        <scrollbox
          style={{ width: Math.max(28, Math.floor((renderer?.terminalWidth ?? 100) * 0.28)), flexShrink: 0 }}
          rootOptions={{ border: true, borderColor: focusMode === "tree" ? theme.accent : theme.borderColor, backgroundColor: theme.panelColor, title: " Files " }}
          viewportOptions={{ backgroundColor: theme.panelColor }}
          contentOptions={{ backgroundColor: theme.panelColor, paddingLeft: 1 }}
        >
          <text content={tree} />
        </scrollbox>
      </box>
    </box>
  )
}

try {
  git(["rev-parse", "--is-inside-work-tree"])
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  renderer.setBackgroundColor(theme.backgroundColor)
  createRoot(renderer).render(<App />)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
