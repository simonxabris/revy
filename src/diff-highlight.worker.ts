import { getFiletypeFromFileName, getHighlighterOptions, getSharedHighlighter, processPatch, renderDiffWithHighlighter, type DiffsHighlighter, type FileDiffMetadata } from "@pierre/diffs"
import type { HighlightedDiffCode } from "./diff-rendering"

export type DiffHighlightFile = { path: string; status: string }

type HighlightRequest = { type: "highlight"; id: string; filePath: string; diff: string }
type EnqueueFilesRequest = { type: "enqueueFiles"; files: DiffHighlightFile[]; cwd: string }
type DisposeRequest = { type: "dispose" }
type WorkerRequest = HighlightRequest | EnqueueFilesRequest | DisposeRequest

type HighlightedMessage = { type: "highlighted"; id?: string; filePath: string; cacheKey: string; highlighted: HighlightedDiffCode }
type ErrorMessage = { type: "error"; id?: string; filePath?: string; message: string }
type ReadyMessage = { type: "ready" }

type HastNode = HighlightedDiffCode["deletionLines"][number]

const workerGlobal = globalThis as unknown as {
  postMessage: (message: ReadyMessage | HighlightedMessage | ErrorMessage) => void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  close: () => void
}

let disposed = false
let currentCwd = process.cwd()
const pendingPrehighlightKeys = new Set<string>()

const highlighterPromise: Promise<DiffsHighlighter> = getSharedHighlighter({
  ...getHighlighterOptions("tsx", { theme: "pierre-dark" }),
  langs: ["tsx", "typescript", "javascript", "jsx", "json", "markdown", "css", "html", "bash", "yaml", "rust", "text"],
  preferredHighlighter: "shiki-js",
})

void highlighterPromise.then(() => workerGlobal.postMessage({ type: "ready" } satisfies ReadyMessage)).catch((error) => {
  workerGlobal.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) } satisfies ErrorMessage)
})

function gitDiff(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const stdout = new TextDecoder().decode(result.stdout)
  if (!result.success && stdout.length === 0) {
    const message = new TextDecoder().decode(result.stderr).trim()
    throw new Error(message || `git ${args.join(" ")} failed`)
  }
  return stdout
}

function loadDiff(file: DiffHighlightFile, cwd: string): string {
  if (file.status === "??") return gitDiff(["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file.path], cwd)
  return gitDiff(["diff", "--no-color", "--no-ext-diff", "HEAD", "--", file.path], cwd)
}

function cacheKeyFor(metadata: FileDiffMetadata): string {
  return metadata.cacheKey ?? `${metadata.name}:${metadata.deletionLines.join("\n")}:${metadata.additionLines.join("\n")}`
}

function parseDiffMetadata(diff: string, filePath: string): FileDiffMetadata {
  const metadata = processPatch(diff, filePath).files[0]
  if (!metadata) throw new Error("Unable to parse diff")
  metadata.lang = getFiletypeFromFileName(metadata.name)
  return metadata
}

async function highlightDiff(filePath: string, diff: string): Promise<{ cacheKey: string; highlighted: HighlightedDiffCode }> {
  const metadata = parseDiffMetadata(diff, filePath)
  const highlighter = await highlighterPromise
  const result = renderDiffWithHighlighter(metadata, highlighter, {
    theme: "pierre-dark",
    useTokenTransformer: false,
    tokenizeMaxLineLength: 1000,
    lineDiffType: "word-alt",
    maxLineDiffLength: 10000,
  })
  return {
    cacheKey: cacheKeyFor(metadata),
    highlighted: {
      deletionLines: result.code.deletionLines as HastNode[],
      additionLines: result.code.additionLines as HastNode[],
    },
  }
}

async function handleHighlight(request: HighlightRequest): Promise<void> {
  try {
    const { cacheKey, highlighted } = await highlightDiff(request.filePath, request.diff)
    if (!disposed) workerGlobal.postMessage({ type: "highlighted", id: request.id, filePath: request.filePath, cacheKey, highlighted } satisfies HighlightedMessage)
  } catch (error) {
    if (!disposed) workerGlobal.postMessage({ type: "error", id: request.id, filePath: request.filePath, message: error instanceof Error ? error.message : String(error) } satisfies ErrorMessage)
  }
}

async function handleEnqueueFiles(files: DiffHighlightFile[], cwd: string): Promise<void> {
  for (const file of files) {
    if (disposed) return
    const key = `${cwd}\0${file.status}\0${file.path}`
    if (pendingPrehighlightKeys.has(key)) continue
    pendingPrehighlightKeys.add(key)
    try {
      const diff = loadDiff(file, cwd)
      if (!diff.startsWith("diff --git") && !diff.startsWith("--- ")) continue
      const { cacheKey, highlighted } = await highlightDiff(file.path, diff)
      if (!disposed) workerGlobal.postMessage({ type: "highlighted", filePath: file.path, cacheKey, highlighted } satisfies HighlightedMessage)
    } catch (error) {
      if (!disposed) workerGlobal.postMessage({ type: "error", filePath: file.path, message: error instanceof Error ? error.message : String(error) } satisfies ErrorMessage)
    }
  }
}

workerGlobal.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  if (message.type === "dispose") {
    disposed = true
    workerGlobal.close()
    return
  }
  if (message.type === "highlight") void handleHighlight(message)
  if (message.type === "enqueueFiles") {
    currentCwd = message.cwd
    void handleEnqueueFiles(message.files, currentCwd)
  }
}
