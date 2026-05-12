#!/usr/bin/env bun
import nightOwl from "tm-themes/themes/github-dark.json"
import { textMateThemeToDiffTheme } from "../src/theme-mapper"
import { getHighlighterOptions, getSharedHighlighter, type DiffsHighlighter } from "@pierre/diffs"
import {
  buildTerminalDiffRows,
  highlightDiffMetadata,
  parseDiffMetadata,
} from "../src/diff-rendering"

const benchmarkPatch = "diff --git a/src/index.tsx b/src/index.tsx\nindex 8ee7a93..973ea99 100755\n--- a/src/index.tsx\n+++ b/src/index.tsx\n@@ -2,13 +2,14 @@\n /** @jsxImportSource @opentui/react */\n import { writeFileSync } from \"node:fs\"\n import { useEffect, useMemo, useRef, useState } from \"react\"\n-import { createCliRenderer, fg, bold, pathToFiletype, t, StyledText, type DiffRenderable, type TextareaRenderable, type TextChunk } from \"@opentui/core\"\n+import { createCliRenderer, fg, bold, t, StyledText, type BoxRenderable, type ScrollBoxRenderable, type TextareaRenderable, type TextChunk } from \"@opentui/core\"\n import { createRoot, useKeyboard, useRenderer } from \"@opentui/react\"\n import { useMachine } from \"@xstate/react\"\n import nightOwl from 'tm-themes/themes/github-dark.json'\n import { textMateThemeToDiffTheme } from \"./theme-mapper\"\n import { reviewMachine, type ReviewComment } from \"./review-machine\"\n import { availableAgents, dispatchReviewFix, listProviderModels, type AgentId, type AgentProviderModelOption } from \"./agents\"\n+import { EMPTY_PARSED_DIFF_STATE, buildTerminalDiffRows, getDiffLineTypes, highlightedDiffCache, highlightDiffMetadata, maxLineNumber, parseDiffMetadata, renderTerminalDiffRow, type LineColor, type ParsedDiffState } from \"./diff-rendering\"\n \n interface ChangedFile {\n   path: string\n@@ -112,25 +113,6 @@ function loadDiff(file: ChangedFile): string {\n   return gitDiff([\"diff\", \"HEAD\", \"--\", file.path])\n }\n \n-function filetypeForDiffPath(path: string): string | undefined {\n-  const filetype = pathToFiletype(path)\n-  return filetype === \"json\" ? \"javascript\" : filetype\n-}\n-\n-type DiffLineType = \"add\" | \"remove\" | \"context\"\n-\n-function getDiffLineTypes(diff: string): DiffLineType[] {\n-  return diff\n-    .split(\"\\n\")\n-    .filter((line) => !line.startsWith(\"diff --git\") && !line.startsWith(\"index \") && !line.startsWith(\"--- \") && !line.startsWith(\"+++ \") && !line.startsWith(\"@@\"))\n-    .flatMap((line) => {\n-      if (line.startsWith(\"+\")) return [\"add\" as const]\n-      if (line.startsWith(\"-\")) return [\"remove\" as const]\n-      if (line.startsWith(\" \")) return [\"context\" as const]\n-      return []\n-    })\n-}\n-\n function fuzzyMatches(value: string, query: string): boolean {\n   let valueIndex = 0\n   const normalizedValue = value.toLowerCase()\n@@ -196,9 +178,11 @@ function App() {\n   const [agentOptionsStatus, setAgentOptionsStatus] = useState<\"idle\" | \"loading\" | \"ready\" | \"error\">(\"idle\")\n   const [agentRunStatus, setAgentRunStatus] = useState<\"idle\" | \"running\" | \"done\" | \"error\">(\"idle\")\n   const [agentRunMessage, setAgentRunMessage] = useState<string | null>(null)\n+  const [parsedDiff, setParsedDiff] = useState<ParsedDiffState>(EMPTY_PARSED_DIFF_STATE)\n   const [reviewState, sendReview] = useMachine(reviewMachine)\n   const commentsByFileRef = useRef(reviewState.context.commentsByFile)\n-  const diffRef = useRef<DiffRenderable | null>(null)\n+  const diffPanelRef = useRef<BoxRenderable | null>(null)\n+  const diffScrollRef = useRef<ScrollBoxRenderable | null>(null)\n   const commentTextareaRef = useRef<TextareaRenderable | null>(null)\n   const diffTheme = codingTheme\n   const isDraftingComment = reviewState.matches(\"draftingComment\")\n@@ -222,7 +206,7 @@ function App() {\n   const diff = selected ? loadDiff(selected) : \"\"\n   const hasPatch = diff.startsWith(\"diff --git\") || diff.startsWith(\"--- \")\n   const diffLineTypes = useMemo(() => getDiffLineTypes(diff), [diff])\n-  const diffLineCount = diffLineTypes.length\n+  const diffLineCount = parsedDiff.rows.length || diffLineTypes.length\n   const selectedRange = selectionAnchorLine === null\n     ? null\n     : {\n@@ -231,48 +215,52 @@ function App() {\n     }\n \n   useEffect(() => {\n-    const diffRenderable = diffRef.current as unknown as {\n-      leftCodeRenderable?: { scrollY: number }\n-      rightCodeRenderable?: { scrollY: number }\n-    } | null\n-    if (diffRenderable?.leftCodeRenderable) diffRenderable.leftCodeRenderable.scrollY = diffScrollY\n-    if (diffRenderable?.rightCodeRenderable) diffRenderable.rightCodeRenderable.scrollY = diffScrollY\n-    renderer?.requestRender()\n-  }, [diffScrollY, renderer])\n+    if (!hasPatch) {\n+      setParsedDiff(EMPTY_PARSED_DIFF_STATE)\n+      return\n+    }\n \n-  useEffect(() => {\n-    if (!hasPatch || !diffRef.current) return\n+    let cancelled = false\n \n-    const lineColors = new Map<number, { gutter: string; content: string }>()\n-    diffLineTypes.forEach((type, index) => {\n-      if (type === \"add\") lineColors.set(index, { gutter: diffTheme.addedLineNumberBg, content: diffTheme.addedBg })\n-      else if (type === \"remove\") lineColors.set(index, { gutter: diffTheme.removedLineNumberBg, content: diffTheme.removedBg })\n-      else lineColors.set(index, { gutter: diffTheme.lineNumberBg, content: diffTheme.contextBg })\n-    })\n+    try {\n+      const metadata = parseDiffMetadata(diff, selected?.path ?? \"diff\")\n+\n+      const cachedHighlight = highlightedDiffCache.get(metadata.cacheKey ?? \"\") ?? null\n+      setParsedDiff({\n+        metadata,\n+        highlighted: cachedHighlight,\n+        rows: buildTerminalDiffRows(metadata, cachedHighlight, diffTheme),\n+        error: null,\n+      })\n \n-    const draftRange = activeDraft && activeDraft.filePath === selected?.path\n-      ? { start: activeDraft.diffStartLine, end: activeDraft.diffEndLine }\n-      : null\n-    const highlightedRange = isDraftingComment ? draftRange : selectedRange\n-    const commentsForSelectedFile = selected ? reviewState.context.commentsByFile[selected.path] ?? [] : []\n-    for (const comment of commentsForSelectedFile) {\n-      for (let line = comment.diffStartLine; line <= comment.diffEndLine; line++) {\n-        const existing = lineColors.get(line)\n-        lineColors.set(line, { gutter: \"#d29922\", content: existing?.content ?? diffTheme.contextBg })\n+      if (!cachedHighlight) {\n+        void highlightDiffMetadata(metadata)\n+          .then((highlighted) => {\n+            if (!cancelled) {\n+              setParsedDiff({\n+                metadata,\n+                highlighted,\n+                rows: buildTerminalDiffRows(metadata, highlighted, diffTheme),\n+                error: null,\n+              })\n+            }\n+          })\n+          .catch(() => {\n+            // Keep the immediate plain-text rows if highlighting fails.\n+          })\n       }\n+    } catch (error) {\n+      setParsedDiff({ metadata: null, highlighted: null, rows: [], error: error instanceof Error ? error.message : String(error) })\n     }\n \n-    if (highlightedRange) {\n-      for (let line = highlightedRange.start; line <= highlightedRange.end; line++) {\n-        lineColors.set(line, { gutter: diffTheme.selectionBg, content: diffTheme.selectionBg })\n-      }\n-    } else if (focusMode === \"diff\" && diffLineCount > 0) {\n-      lineColors.set(currentDiffLine, { gutter: diffTheme.activeLineNumberBg, content: diffTheme.activeLineBg })\n+    return () => {\n+      cancelled = true\n     }\n+  }, [diff, diffTheme, hasPatch, selected?.path])\n \n-    diffRef.current.setLineColors(lineColors)\n-    renderer?.requestRender()\n-  }, [activeDraft, currentDiffLine, diffLineCount, diffLineTypes, diffTheme, focusMode, hasPatch, isDraftingComment, renderer, reviewState.context.commentsByFile, selected, selectedRange])\n+  useEffect(() => {\n+    diffScrollRef.current?.scrollTo(diffScrollY)\n+  }, [diffScrollY])\n \n   function resetDiffState(): void {\n     setDiffScrollY(0)\n@@ -287,9 +275,19 @@ function App() {\n     setSelectedIndex(clampedIndex)\n   }\n \n+  function getDiffViewportHeight(): number {\n+    const scrollViewportHeight = diffScrollRef.current?.viewport.height ?? 0\n+    if (scrollViewportHeight > 0) return scrollViewportHeight\n+\n+    const panelHeight = diffPanelRef.current?.height ?? 0\n+    if (panelHeight > 2) return panelHeight - 2\n+\n+    return Math.max(1, (renderer?.terminalHeight ?? 24) - 5)\n+  }\n+\n   function moveDiffCursor(delta: number, extendSelection = false): void {\n     if (diffLineCount === 0) return\n-    const viewportHeight = Math.max(1, (renderer?.terminalHeight ?? 24) - 5)\n+    const viewportHeight = getDiffViewportHeight()\n \n     setCurrentDiffLine((line) => {\n       if (extendSelection) setSelectionAnchorLine((anchor) => anchor ?? line)\n@@ -490,8 +488,8 @@ function App() {\n \n     if (key.name === \"down\" || key.name === \"j\") moveDiffCursor(1, key.shift)\n     if (key.name === \"up\" || key.name === \"k\") moveDiffCursor(-1, key.shift)\n-    if (key.name === \"pagedown\") moveDiffCursor(Math.max(1, (renderer?.terminalHeight ?? 24) - 6))\n-    if (key.name === \"pageup\") moveDiffCursor(-Math.max(1, (renderer?.terminalHeight ?? 24) - 6))\n+    if (key.name === \"pagedown\") moveDiffCursor(Math.max(1, getDiffViewportHeight() - 1))\n+    if (key.name === \"pageup\") moveDiffCursor(-Math.max(1, getDiffViewportHeight() - 1))\n     if (key.name === \"home\") {\n       setSelectionAnchorLine(null)\n       setCurrentDiffLine(0)\n@@ -500,7 +498,7 @@ function App() {\n   })\n \n   const tree = renderFileTree(visibleFiles, effectiveSelectedIndex, files.length === 0 ? \"No changes found.\" : \"No matching files.\")\n-  const diffViewportHeight = Math.max(1, (renderer?.terminalHeight ?? 24) - 5)\n+  const diffViewportHeight = getDiffViewportHeight()\n   const commentRow = activeDraft === null || activeDraft.filePath !== selected?.path ? null : activeDraft.diffEndLine - diffScrollY\n   const isCommentVisible = commentRow !== null && commentRow >= 0 && commentRow < diffViewportHeight\n   const commentCount = Object.values(reviewState.context.commentsByFile).reduce((count, comments) => count + comments.length, 0)\n@@ -523,6 +521,27 @@ function App() {\n   const agentTabs = availableAgents\n     .map((agent, index) => `${agent.id === selectedPickerAgent ? \"[\" : \" \"}${index + 1} ${agent.label}${agent.id === selectedPickerAgent ? \"]\" : \" \"}`)\n     .join(\"  \")\n+  const pierreOverlays = new Map<number, LineColor>()\n+  const draftRange = activeDraft && activeDraft.filePath === selected?.path\n+    ? { start: activeDraft.diffStartLine, end: activeDraft.diffEndLine }\n+    : null\n+  const highlightedRange = isDraftingComment ? draftRange : selectedRange\n+  const commentsForSelectedFile = selected ? reviewState.context.commentsByFile[selected.path] ?? [] : []\n+  for (const comment of commentsForSelectedFile) {\n+    for (let line = comment.diffStartLine; line <= comment.diffEndLine; line++) {\n+      pierreOverlays.set(line, { gutter: \"#d29922\", content: diffTheme.contextBg })\n+    }\n+  }\n+  if (highlightedRange) {\n+    for (let line = highlightedRange.start; line <= highlightedRange.end; line++) {\n+      pierreOverlays.set(line, { gutter: diffTheme.selectionBg, content: diffTheme.selectionBg })\n+    }\n+  } else if (focusMode === \"diff\" && diffLineCount > 0) {\n+    pierreOverlays.set(currentDiffLine, { gutter: diffTheme.activeLineNumberBg, content: diffTheme.activeLineBg })\n+  }\n+  const sidePanelWidth = Math.max(28, Math.floor((renderer?.terminalWidth ?? 100) * 0.28))\n+  const diffContentWidth = Math.max(30, (renderer?.terminalWidth ?? 100) - sidePanelWidth - 6)\n+  const lineNumberDigits = String(maxLineNumber(parsedDiff.metadata)).length\n \n   return (\n     <box style={{ width: \"100%\", height: \"100%\", flexDirection: \"column\", backgroundColor: theme.backgroundColor }}>\n@@ -565,6 +584,7 @@ function App() {\n \n       <box style={{ flexGrow: 1, flexDirection: \"row\", backgroundColor: theme.backgroundColor }}>\n         <box\n+          ref={diffPanelRef}\n           title={selected ? ` Diff: ${selected.path} ` : \" Diff \"}\n           style={{\n             flexGrow: 1,\n@@ -576,28 +596,35 @@ function App() {\n         >\n           {hasPatch ? (\n             <>\n-              <diff\n-                ref={diffRef}\n-                diff={diff}\n-                view=\"split\"\n-                filetype={selected ? filetypeForDiffPath(selected.path) : undefined}\n-                syntaxStyle={diffTheme.syntaxStyle}\n-                showLineNumbers={true}\n-                wrapMode=\"none\"\n-                fg={diffTheme.fg}\n-                addedBg={diffTheme.addedBg}\n-                removedBg={diffTheme.removedBg}\n-                contextBg={diffTheme.contextBg}\n-                addedSignColor={diffTheme.addedSignColor}\n-                removedSignColor={diffTheme.removedSignColor}\n-                lineNumberFg={diffTheme.lineNumberFg}\n-                lineNumberBg={diffTheme.lineNumberBg}\n-                addedLineNumberBg={diffTheme.addedLineNumberBg}\n-                removedLineNumberBg={diffTheme.removedLineNumberBg}\n-                selectionBg={diffTheme.selectionBg}\n-                selectionFg={diffTheme.selectionFg}\n+              <scrollbox\n+                ref={diffScrollRef}\n+                scrollY={true}\n+                viewportCulling={true}\n+                focused={false}\n+                rootOptions={{ backgroundColor: diffTheme.backgroundColor }}\n+                wrapperOptions={{ backgroundColor: diffTheme.backgroundColor }}\n+                viewportOptions={{ backgroundColor: diffTheme.backgroundColor }}\n+                contentOptions={{ backgroundColor: diffTheme.backgroundColor }}\n+                verticalScrollbarOptions={{ visible: false }}\n+                horizontalScrollbarOptions={{ visible: false }}\n                 style={{ flexGrow: 1, flexShrink: 1 }}\n-              />\n+              >\n+                <box style={{ width: \"100%\", flexDirection: \"column\", backgroundColor: diffTheme.backgroundColor }}>\n+                  {parsedDiff.error ? (\n+                    <text content={`Failed to render diff: ${parsedDiff.error}`} fg={diffTheme.fg} bg={diffTheme.backgroundColor} />\n+                  ) : parsedDiff.rows.length === 0 ? (\n+                    <text content=\"Rendering diff...\" fg={diffTheme.fg} bg={diffTheme.backgroundColor} />\n+                  ) : parsedDiff.rows.map((row, index) => (\n+                    <box key={`diff-row:${index}`} style={{ width: \"100%\", height: 1, flexShrink: 0, backgroundColor: diffTheme.backgroundColor }}>\n+                      <text\n+                        content={renderTerminalDiffRow(row, index, lineNumberDigits, diffContentWidth, diffTheme, pierreOverlays, theme)}\n+                        wrapMode=\"none\"\n+                        truncate={true}\n+                      />\n+                    </box>\n+                  ))}\n+                </box>\n+              </scrollbox>\n \n               {isCommentVisible ? (\n                 <box\n@@ -648,7 +675,7 @@ function App() {\n \n         <box\n           style={{\n-            width: Math.max(28, Math.floor((renderer?.terminalWidth ?? 100) * 0.28)),\n+            width: sidePanelWidth,\n             flexShrink: 0,\n             flexDirection: \"column\",\n             backgroundColor: theme.panelColor,\n"

const diffTheme = textMateThemeToDiffTheme(nightOwl)
const filePath = "src/index.tsx"

function now(): number {
  return performance.now()
}

function fmt(ms: number): string {
  return `${ms.toFixed(2)}ms`
}

const repeatArgIndex = Bun.argv.findIndex((arg) => arg === "--repeat" || arg === "-n")
const repeat = repeatArgIndex === -1 ? 1 : Math.max(1, Number(Bun.argv[repeatArgIndex + 1] ?? 1))

let totalParse = 0
let totalRowsPlain = 0
let totalHighlighterInit = 0
let totalRenderDiffWithHighlighter = 0
let totalExtractHighlightedCode = 0
let totalRowsHighlighted = 0

let highlighterPromise: Promise<DiffsHighlighter> | null = null

function getBenchHighlighter(): Promise<DiffsHighlighter> {
  highlighterPromise ??= getSharedHighlighter({
    ...getHighlighterOptions("tsx", { theme: "pierre-dark" }),
    langs: ["tsx", "typescript", "javascript", "jsx", "json", "markdown", "css", "html", "bash", "yaml", "rust", "text"],
    preferredHighlighter: "shiki-js",
  })
  return highlighterPromise
}

for (let run = 1; run <= repeat; run++) {
  const parseStart = now()
  const metadata = parseDiffMetadata(benchmarkPatch, filePath)
  const parseMs = now() - parseStart

  const rowsPlainStart = now()
  const plainRows = buildTerminalDiffRows(metadata, null, diffTheme)
  const rowsPlainMs = now() - rowsPlainStart

  const highlighterInitStart = now()
  const highlighter = await getBenchHighlighter()
  const highlighterInitMs = now() - highlighterInitStart

  void highlighter

  const renderDiffWithHighlighterStart = now()
  const highlighted = await highlightDiffMetadata(metadata)
  const renderDiffWithHighlighterMs = now() - renderDiffWithHighlighterStart

  const extractHighlightedCodeMs = 0

  const rowsHighlightedStart = now()
  const highlightedRows = buildTerminalDiffRows(metadata, highlighted, diffTheme)
  const rowsHighlightedMs = now() - rowsHighlightedStart

  totalParse += parseMs
  totalRowsPlain += rowsPlainMs
  totalHighlighterInit += highlighterInitMs
  totalRenderDiffWithHighlighter += renderDiffWithHighlighterMs
  totalExtractHighlightedCode += extractHighlightedCodeMs
  totalRowsHighlighted += rowsHighlightedMs

  console.log(`Run ${run}/${repeat}`)
  console.log(`  parse:                       ${fmt(parseMs)}`)
  console.log(`  rows plain:                  ${fmt(rowsPlainMs)}`)
  console.log(`  highlighter init/get:        ${fmt(highlighterInitMs)}`)
  console.log(`  renderDiffWithHighlighter:   ${fmt(renderDiffWithHighlighterMs)}`)
  console.log(`  extract highlighted code:    ${fmt(extractHighlightedCodeMs)}`)
  console.log(`  rows highlighted:            ${fmt(rowsHighlightedMs)}`)
  console.log(`  total:                       ${fmt(parseMs + rowsPlainMs + highlighterInitMs + renderDiffWithHighlighterMs + extractHighlightedCodeMs + rowsHighlightedMs)}`)
  console.log(`  rows:              ${highlightedRows.length} (${plainRows.length} plain)`)
}

if (repeat > 1) {
  console.log("\nAverage")
  console.log(`  parse:                       ${fmt(totalParse / repeat)}`)
  console.log(`  rows plain:                  ${fmt(totalRowsPlain / repeat)}`)
  console.log(`  highlighter init/get:        ${fmt(totalHighlighterInit / repeat)}`)
  console.log(`  renderDiffWithHighlighter:   ${fmt(totalRenderDiffWithHighlighter / repeat)}`)
  console.log(`  extract highlighted code:    ${fmt(totalExtractHighlightedCode / repeat)}`)
  console.log(`  rows highlighted:            ${fmt(totalRowsHighlighted / repeat)}`)
  console.log(`  total:                       ${fmt((totalParse + totalRowsPlain + totalHighlighterInit + totalRenderDiffWithHighlighter + totalExtractHighlightedCode + totalRowsHighlighted) / repeat)}`)
}
