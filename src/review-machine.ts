import { assign, createMachine } from "xstate"

export interface ReviewComment {
  id: string
  filePath: string
  diffStartLine: number
  diffEndLine: number
  body: string
  createdAt: number
}

export interface CommentDraft {
  commentId: string | null
  filePath: string
  diffStartLine: number
  diffEndLine: number
  body: string
}

export interface ReviewContext {
  commentsByFile: Record<string, ReviewComment[]>
  draft: CommentDraft | null
}

type StartCommentEvent = {
  type: "comment.start"
  filePath: string
  startLine: number
  endLine: number
}

type EditCommentEvent = {
  type: "comment.edit"
  comment: ReviewComment
}

type UpdateDraftEvent = {
  type: "comment.updateDraft"
  body: string
}

type DeleteCommentEvent = {
  type: "comment.delete"
  filePath: string
  commentId: string
}

export type ReviewEvent =
  | StartCommentEvent
  | EditCommentEvent
  | UpdateDraftEvent
  | DeleteCommentEvent
  | { type: "comment.save" }
  | { type: "comment.cancel" }

export const reviewMachine = createMachine({
  types: {} as {
    context: ReviewContext
    events: ReviewEvent
  },
  id: "review",
  context: {
    commentsByFile: {},
    draft: null,
  },
  initial: "reading",
  states: {
    reading: {
      on: {
        "comment.start": {
          target: "draftingComment",
          actions: assign({
            draft: ({ event }) => ({
              commentId: null,
              filePath: event.filePath,
              diffStartLine: Math.min(event.startLine, event.endLine),
              diffEndLine: Math.max(event.startLine, event.endLine),
              body: "",
            }),
          }),
        },
        "comment.edit": {
          target: "draftingComment",
          actions: assign({
            draft: ({ event }) => ({
              commentId: event.comment.id,
              filePath: event.comment.filePath,
              diffStartLine: event.comment.diffStartLine,
              diffEndLine: event.comment.diffEndLine,
              body: event.comment.body,
            }),
          }),
        },
        "comment.delete": {
          actions: assign({
            commentsByFile: ({ context, event }) => ({
              ...context.commentsByFile,
              [event.filePath]: (context.commentsByFile[event.filePath] ?? []).filter(
                (comment) => comment.id !== event.commentId,
              ),
            }),
          }),
        },
      },
    },
    draftingComment: {
      on: {
        "comment.updateDraft": {
          actions: assign({
            draft: ({ context, event }) =>
              context.draft
                ? {
                    ...context.draft,
                    body: event.body,
                  }
                : null,
          }),
        },
        "comment.save": {
          guard: ({ context }) => Boolean(context.draft?.body.trim()),
          target: "reading",
          actions: assign({
            commentsByFile: ({ context }) => {
              if (!context.draft) return context.commentsByFile

              const comment: ReviewComment = {
                id: context.draft.commentId ?? crypto.randomUUID(),
                filePath: context.draft.filePath,
                diffStartLine: context.draft.diffStartLine,
                diffEndLine: context.draft.diffEndLine,
                body: context.draft.body.trim(),
                createdAt: Date.now(),
              }

              const existingComments = context.commentsByFile[comment.filePath] ?? []
              const nextComments = context.draft.commentId
                ? existingComments.map((existingComment) =>
                    existingComment.id === context.draft?.commentId ? comment : existingComment,
                  )
                : [...existingComments, comment]

              return {
                ...context.commentsByFile,
                [comment.filePath]: nextComments,
              }
            },
            draft: null,
          }),
        },
        "comment.cancel": {
          target: "reading",
          actions: assign({
            draft: null,
          }),
        },
      },
    },
  },
})
