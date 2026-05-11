import type { ReviewFixRequest } from "./types"

function formatDiffLineRange(startLine: number, endLine: number): string {
  const start = startLine + 1
  const end = endLine + 1
  return start === end ? `diff line ${start}` : `diff lines ${start}-${end}`
}

export function buildReviewFixPrompt(request: ReviewFixRequest): string {
  const comments = request.comments
    .map((comment, index) =>
      [
        `Comment ${index + 1}:`,
        `File: ${comment.filePath}`,
        `Range: ${formatDiffLineRange(comment.diffStartLine, comment.diffEndLine)}`,
        "Review comment:",
        comment.body,
      ].join("\n"),
    )
    .join("\n\n")

  return [
    "You are fixing review comments in the current Git repository.",
    "",
    "Apply code changes that address the review comments below.",
    "Modify the files directly. Do not ask for confirmation unless you are blocked.",
    "Preserve unrelated changes and keep the patch focused on the comments.",
    "",
    comments,
  ].join("\n")
}
