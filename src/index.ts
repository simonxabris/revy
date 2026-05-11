import React, { useMemo, useState } from "react"
import { createCliRenderer, fg, bold, t, SyntaxStyle, parseColor } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer } from "@opentui/react"

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

function filetypeForPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase()
  const byExtension: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    md: "markdown",
    markdown: "markdown",
    zig: "zig",
  }
  return ext ? byExtension[ext] : undefined
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
  syntaxStyle: {
    keyword: { fg: parseColor("#ff7b72"), bold: true },
    "keyword.import": { fg: parseColor("#ff7b72"), bold: true },
    string: { fg: parseColor("#a5d6ff") },
    comment: { fg: parseColor("#8b949e"), italic: true },
    number: { fg: parseColor("#79c0ff") },
    boolean: { fg: parseColor("#79c0ff") },
    constant: { fg: parseColor("#79c0ff") },
    function: { fg: parseColor("#d2a8ff") },
    "function.call": { fg: parseColor("#d2a8ff") },
    constructor: { fg: parseColor("#ffa657") },
    type: { fg: parseColor("#ffa657") },
    operator: { fg: parseColor("#ff7b72") },
    variable: { fg: parseColor("#e6edf3") },
    property: { fg: parseColor("#79c0ff") },
    bracket: { fg: parseColor("#e6edf3") },
    punctuation: { fg: parseColor("#e6edf3") },
    default: { fg: parseColor("#e6edf3") },
  },
}

function App() {
  const renderer = useRenderer()
  const [files, setFiles] = useState<ChangedFile[]>(() => loadChangedFiles())
  const [selectedIndex, setSelectedIndex] = useState(0)
  const syntaxStyle = useMemo(() => SyntaxStyle.fromStyles(theme.syntaxStyle), [])

  const selected = files[selectedIndex]
  const diff = selected ? loadDiff(selected.path) : ""
  const hasPatch = diff.startsWith("diff --git") || diff.startsWith("--- ")

  function refresh(): void {
    const nextFiles = loadChangedFiles()
    setFiles(nextFiles)
    setSelectedIndex((index) => Math.max(0, Math.min(index, nextFiles.length - 1)))
  }

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) renderer?.destroy()
    if (key.name === "r") refresh()
    if (key.name === "down" || key.name === "j") {
      setSelectedIndex((index) => Math.min(files.length - 1, index + 1))
    }
    if (key.name === "up" || key.name === "k") {
      setSelectedIndex((index) => Math.max(0, index - 1))
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
        content: t`${bold(fg(theme.accent)("revy"))} ${fg(theme.muted)("↑/k ↓/j select • r refresh • q quit")}`,
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
            borderColor: theme.borderColor,
            backgroundColor: theme.backgroundColor,
          },
        },
        hasPatch
          ? React.createElement("diff", {
              diff,
              view: "unified",
              filetype: selected ? filetypeForPath(selected.path) : undefined,
              syntaxStyle,
              showLineNumbers: true,
              wrapMode: "none",
              fg: theme.fg,
              addedBg: theme.addedBg,
              removedBg: theme.removedBg,
              contextBg: theme.contextBg,
              addedSignColor: theme.addedSignColor,
              removedSignColor: theme.removedSignColor,
              lineNumberFg: theme.lineNumberFg,
              lineNumberBg: theme.lineNumberBg,
              addedLineNumberBg: theme.addedLineNumberBg,
              removedLineNumberBg: theme.removedLineNumberBg,
              selectionBg: theme.selectionBg,
              selectionFg: theme.selectionFg,
              style: { flexGrow: 1, flexShrink: 1 },
            })
          : React.createElement("text", { content: selected ? "No textual diff for this file." : "No changes found." }),
      ),
      React.createElement(
        "scrollbox",
        {
          style: { width: Math.max(28, Math.floor((renderer?.terminalWidth ?? 100) * 0.28)), flexShrink: 0 },
          rootOptions: { border: true, borderColor: theme.borderColor, backgroundColor: theme.panelColor, title: " Files " },
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
