import { assign, createMachine } from "xstate"

export type FocusMode = "tree" | "diff" | "comment" | "agent"

export interface UiContext {
  focusMode: FocusMode
  diffScrollY: number
  diffScrollX: number
  currentDiffLine: number
  selectionAnchorLine: number | null
}

export type UiEvent =
  | { type: "focus.set"; focusMode: FocusMode }
  | { type: "diff.reset" }
  | { type: "diff.scrollY.set"; value: number }
  | { type: "diff.scrollX.set"; value: number }
  | { type: "diff.currentLine.set"; value: number }
  | { type: "diff.selectionAnchor.set"; value: number | null }
  | { type: "diff.focusFirstSelectableLine"; line: number }
  | { type: "diff.cursorMoved"; line: number; scrollY: number; selectionAnchorLine: number | null }

export const uiMachine = createMachine({
  types: {} as {
    context: UiContext
    events: UiEvent
  },
  id: "ui",
  context: {
    focusMode: "tree",
    diffScrollY: 0,
    diffScrollX: 0,
    currentDiffLine: 0,
    selectionAnchorLine: null,
  },
  on: {
    "focus.set": {
      actions: assign({
        focusMode: ({ event }) => event.focusMode,
      }),
    },
    "diff.reset": {
      actions: assign({
        focusMode: "tree",
        diffScrollY: 0,
        diffScrollX: 0,
        currentDiffLine: 0,
        selectionAnchorLine: null,
      }),
    },
    "diff.scrollY.set": {
      actions: assign({
        diffScrollY: ({ event }) => event.value,
      }),
    },
    "diff.scrollX.set": {
      actions: assign({
        diffScrollX: ({ event }) => event.value,
      }),
    },
    "diff.currentLine.set": {
      actions: assign({
        currentDiffLine: ({ event }) => event.value,
      }),
    },
    "diff.selectionAnchor.set": {
      actions: assign({
        selectionAnchorLine: ({ event }) => event.value,
      }),
    },
    "diff.focusFirstSelectableLine": {
      actions: assign({
        currentDiffLine: ({ event }) => event.line,
        diffScrollY: 0,
        diffScrollX: 0,
        selectionAnchorLine: null,
      }),
    },
    "diff.cursorMoved": {
      actions: assign({
        currentDiffLine: ({ event }) => event.line,
        diffScrollY: ({ event }) => event.scrollY,
        selectionAnchorLine: ({ event }) => event.selectionAnchorLine,
      }),
    },
  },
})
