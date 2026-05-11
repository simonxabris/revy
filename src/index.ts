import React, { useEffect, useMemo, useRef, useState } from "react"
import { createCliRenderer, fg, bold, pathToFiletype, t, type DiffRenderable } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer } from "@opentui/react"
import ayuDark from 'tm-themes/themes/ayu-dark.json'
import { shikiThemeToDiffTheme } from "./theme-mapper"

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
  const [focusMode, setFocusMode] = useState<"tree" | "diff">("tree")
  const [diffScrollY, setDiffScrollY] = useState(0)
  const [currentDiffLine, setCurrentDiffLine] = useState(0)
  const diffRef = useRef<DiffRenderable | null>(null)
  const diffTheme = useMemo(() => shikiThemeToDiffTheme(ayuDark), [])

  const selected = files[selectedIndex]
  const diff = selected ? loadDiff(selected.path) : ""
  const hasPatch = diff.startsWith("diff --git") || diff.startsWith("--- ")
  const diffLineTypes = useMemo(() => getDiffLineTypes(diff), [diff])
  const diffLineCount = diffLineTypes.length

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

    if (focusMode === "diff" && diffLineCount > 0) {
      lineColors.set(currentDiffLine, { gutter: diffTheme.activeLineNumberBg, content: diffTheme.activeLineBg })
    }

    diffRef.current.setLineColors(lineColors)
    renderer?.requestRender()
  }, [currentDiffLine, diffLineCount, diffLineTypes, diffTheme, focusMode, hasPatch, renderer])

  function resetDiffState(): void {
    setDiffScrollY(0)
    setCurrentDiffLine(0)
    setFocusMode("tree")
  }

  function selectFile(nextIndex: number): void {
    const clampedIndex = Math.max(0, Math.min(files.length - 1, nextIndex))
    if (files[clampedIndex]?.path !== selected?.path) resetDiffState()
    setSelectedIndex(clampedIndex)
  }

  function moveDiffCursor(delta: number): void {
    if (diffLineCount === 0) return
    const viewportHeight = Math.max(1, (renderer?.terminalHeight ?? 24) - 5)

    setCurrentDiffLine((line) => {
      const nextLine = Math.max(0, Math.min(diffLineCount - 1, line + delta))
      setDiffScrollY((scrollY) => {
        if (nextLine < scrollY) return nextLine
        if (nextLine >= scrollY + viewportHeight) return nextLine - viewportHeight + 1
        return scrollY
      })
      return nextLine
    })
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
      setFocusMode("tree")
      return
    }

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

    if (key.name === "down" || key.name === "j") moveDiffCursor(1)
    if (key.name === "up" || key.name === "k") moveDiffCursor(-1)
    if (key.name === "pagedown") moveDiffCursor(Math.max(1, (renderer?.terminalHeight ?? 24) - 6))
    if (key.name === "pageup") moveDiffCursor(-Math.max(1, (renderer?.terminalHeight ?? 24) - 6))
    if (key.name === "home") {
      setCurrentDiffLine(0)
      setDiffScrollY(0)
    }
  })

  const tree = files.length
    ? files.map((file, index) => `${index === selectedIndex ? "›" : " "} ${file.status.padEnd(2)} ${file.path}`).join("\n")
    : "No changes found."

  return React.createElement(
    "box",
    { style: { width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.backgroundColor } },
    React.createElement(
      "box",
      {
        title: " revy ",
        style: {
          height: 3,
          flexShrink: 0,
          border: true,
          borderColor: theme.borderColor,
          backgroundColor: theme.panelColor,
          paddingLeft: 1,
          alignItems: "center",
        },
      },
      React.createElement("text", {
        content: t`${bold(fg(theme.accent)("revy"))} ${fg(theme.muted)(focusMode === "tree" ? "tree: ↑/k ↓/j select • enter diff • r refresh • q quit" : `diff: line ${Math.min(currentDiffLine + 1, diffLineCount)}/${diffLineCount} • ↑/k ↓/j move • pgup/pgdn • esc tree • q quit`)}`,
      }),
    ),
    React.createElement(
      "box",
      { style: { flexGrow: 1, flexDirection: "row", backgroundColor: theme.backgroundColor } },
      React.createElement(
        "box",
        {
          title: selected ? ` Diff: ${selected.path} ` : " Diff ",
          style: {
            flexGrow: 1,
            minWidth: 30,
            border: true,
            borderColor: focusMode === "diff" ? theme.accent : theme.borderColor,
            backgroundColor: diffTheme.backgroundColor,
          },
        },
        hasPatch
          ? React.createElement("diff", {
            ref: diffRef,
            diff,
            view: "unified",
            filetype: selected ? filetypeForDiffPath(selected.path) : undefined,
            syntaxStyle: diffTheme.syntaxStyle,
            showLineNumbers: true,
            wrapMode: "none",
            fg: diffTheme.fg,
            addedBg: diffTheme.addedBg,
            removedBg: diffTheme.removedBg,
            contextBg: diffTheme.contextBg,
            addedSignColor: diffTheme.addedSignColor,
            removedSignColor: diffTheme.removedSignColor,
            lineNumberFg: diffTheme.lineNumberFg,
            lineNumberBg: diffTheme.lineNumberBg,
            addedLineNumberBg: diffTheme.addedLineNumberBg,
            removedLineNumberBg: diffTheme.removedLineNumberBg,
            selectionBg: diffTheme.selectionBg,
            selectionFg: diffTheme.selectionFg,
            style: { flexGrow: 1, flexShrink: 1 },
          })
          : React.createElement("text", { content: selected ? "No textual diff for this file." : "No changes found." }),
      ),
      React.createElement(
        "scrollbox",
        {
          style: { width: Math.max(28, Math.floor((renderer?.terminalWidth ?? 100) * 0.28)), flexShrink: 0 },
          rootOptions: { border: true, borderColor: focusMode === "tree" ? theme.accent : theme.borderColor, backgroundColor: theme.panelColor, title: " Files " },
          viewportOptions: { backgroundColor: theme.panelColor },
          contentOptions: { backgroundColor: theme.panelColor, paddingLeft: 1 },
        },
        React.createElement("text", { content: tree }),
      ),
    ),
  )
}

try {
  git(["rev-parse", "--is-inside-work-tree"])
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  renderer.setBackgroundColor(theme.backgroundColor)
  createRoot(renderer).render(React.createElement(App))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
