import { assign, createMachine } from "xstate"
import type { AgentId, AgentProviderModelOption } from "./agents"
import { EMPTY_PARSED_DIFF_STATE, type ParsedDiffState } from "./diff-rendering"

export type FocusMode = "tree" | "diff" | "comment" | "agent"

function resetDiffContext() {
  return {
    diffScrollY: 0,
    diffScrollX: 0,
    currentDiffLine: 0,
    selectionAnchorLine: null,
  }
}

export interface ChangedFile {
  path: string
  status: string
}

export interface UiContext {
  files: ChangedFile[]
  selectedIndex: number
  fileSearchQuery: string
  diffScrollY: number
  diffScrollX: number
  currentDiffLine: number
  selectionAnchorLine: number | null
  selectedAgentIndex: number
  selectedPickerAgent: AgentId
  agentSearchQuery: string
  agentOptions: AgentProviderModelOption[]
  agentOptionsStatus: "idle" | "loading" | "ready" | "error"
  agentRunStatus: "idle" | "running" | "done" | "error"
  agentRunMessage: string | null
  parsedDiff: ParsedDiffState
}

export type UiEvent =
  | { type: "files.set"; files: ChangedFile[]; selectedIndex: number; resetDiff?: boolean }
  | { type: "files.select"; selectedIndex: number; resetDiff?: boolean }
  | { type: "files.search.append"; char: string }
  | { type: "files.search.backspace" }
  | { type: "files.search.clear" }
  | { type: "focus.set"; focusMode: FocusMode }
  | { type: "agent.open" }
  | { type: "agent.pickerAgent.set"; agent: AgentId }
  | { type: "agent.selectedIndex.set"; selectedIndex: number }
  | { type: "agent.search.append"; char: string }
  | { type: "agent.search.backspace" }
  | { type: "agent.options.loading" }
  | { type: "agent.options.loaded"; options: AgentProviderModelOption[] }
  | { type: "agent.options.failed"; message: string }
  | { type: "agent.run.start"; message: string }
  | { type: "agent.run.done"; message: string }
  | { type: "agent.run.error"; message: string }
  | { type: "diff.parsed.set"; parsedDiff: ParsedDiffState }
  | { type: "diff.parsed.reset" }
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
  initial: "tree",
  context: {
    files: [],
    selectedIndex: 0,
    fileSearchQuery: "",
    diffScrollY: 0,
    diffScrollX: 0,
    currentDiffLine: 0,
    selectionAnchorLine: null,
    selectedAgentIndex: 0,
    selectedPickerAgent: "codex",
    agentSearchQuery: "",
    agentOptions: [],
    agentOptionsStatus: "idle",
    agentRunStatus: "idle",
    agentRunMessage: null,
    parsedDiff: EMPTY_PARSED_DIFF_STATE,
  },
  states: {
    tree: {},
    diff: {},
    comment: {},
    agent: {},
  },
  on: {
    "files.set": [
      {
        guard: ({ event }) => Boolean(event.resetDiff),
        target: ".tree",
        actions: assign(({ event }) => ({
          files: event.files,
          selectedIndex: event.selectedIndex,
          ...resetDiffContext(),
        })),
      },
      {
        actions: assign(({ event }) => ({
          files: event.files,
          selectedIndex: event.selectedIndex,
        })),
      },
    ],
    "files.select": [
      {
        guard: ({ event }) => Boolean(event.resetDiff),
        target: ".tree",
        actions: assign(({ event }) => ({
          selectedIndex: event.selectedIndex,
          ...resetDiffContext(),
        })),
      },
      {
        actions: assign(({ event }) => ({
          selectedIndex: event.selectedIndex,
        })),
      },
    ],
    "files.search.append": {
      target: ".tree",
      actions: assign(({ context, event }) => ({
        fileSearchQuery: context.fileSearchQuery + event.char,
        selectedIndex: 0,
        ...resetDiffContext(),
      })),
    },
    "files.search.backspace": {
      target: ".tree",
      actions: assign(({ context }) => ({
        fileSearchQuery: context.fileSearchQuery.slice(0, -1),
        selectedIndex: 0,
        ...resetDiffContext(),
      })),
    },
    "files.search.clear": {
      target: ".tree",
      actions: assign({
        fileSearchQuery: "",
        selectedIndex: 0,
        ...resetDiffContext(),
      }),
    },
    "focus.set": [
      { guard: ({ event }) => event.focusMode === "tree", target: ".tree" },
      { guard: ({ event }) => event.focusMode === "diff", target: ".diff" },
      { guard: ({ event }) => event.focusMode === "comment", target: ".comment" },
      { guard: ({ event }) => event.focusMode === "agent", target: ".agent" },
    ],
    "agent.open": {
      target: ".agent",
      actions: assign(({ context }) => ({
        agentRunStatus: "idle" as const,
        agentRunMessage: null,
        selectedAgentIndex: 0,
        agentSearchQuery: "",
        agentOptionsStatus: context.agentOptionsStatus === "error" ? "idle" as const : context.agentOptionsStatus,
      })),
    },
    "agent.pickerAgent.set": {
      actions: assign({
        selectedPickerAgent: ({ event }) => event.agent,
        selectedAgentIndex: 0,
      }),
    },
    "agent.selectedIndex.set": {
      actions: assign({
        selectedAgentIndex: ({ event }) => event.selectedIndex,
      }),
    },
    "agent.search.append": {
      actions: assign(({ context, event }) => ({
        agentSearchQuery: context.agentSearchQuery + event.char,
        selectedAgentIndex: 0,
      })),
    },
    "agent.search.backspace": {
      actions: assign(({ context }) => ({
        agentSearchQuery: context.agentSearchQuery.slice(0, -1),
        selectedAgentIndex: 0,
      })),
    },
    "agent.options.loading": {
      actions: assign({ agentOptionsStatus: "loading" }),
    },
    "agent.options.loaded": {
      actions: assign({
        agentOptions: ({ event }) => event.options,
        selectedAgentIndex: 0,
        agentOptionsStatus: "ready",
      }),
    },
    "agent.options.failed": {
      actions: assign({
        agentOptions: [],
        agentOptionsStatus: "error",
        agentRunStatus: "error",
        agentRunMessage: ({ event }) => event.message,
      }),
    },
    "agent.run.start": {
      target: ".diff",
      actions: assign({
        agentRunStatus: "running",
        agentRunMessage: ({ event }) => event.message,
      }),
    },
    "agent.run.done": {
      actions: assign({
        agentRunStatus: "done",
        agentRunMessage: ({ event }) => event.message,
      }),
    },
    "agent.run.error": {
      actions: assign({
        agentRunStatus: "error",
        agentRunMessage: ({ event }) => event.message,
      }),
    },
    "diff.parsed.set": {
      actions: assign({
        parsedDiff: ({ event }) => event.parsedDiff,
      }),
    },
    "diff.parsed.reset": {
      actions: assign({
        parsedDiff: EMPTY_PARSED_DIFF_STATE,
      }),
    },
    "diff.reset": {
      target: ".tree",
      actions: assign(resetDiffContext()),
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
