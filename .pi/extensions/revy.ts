import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type RevyExport = {
  version?: number;
  repoRoot?: string;
  comments?: Array<{
    id?: string;
    filePath: string;
    diffStartLine: number;
    diffEndLine: number;
    body: string;
    createdAt?: string;
  }>;
};

function shellWords(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
}

function formatComments(exported: RevyExport): string {
  const comments = exported.comments ?? [];
  if (comments.length === 0) return "";

  return [
    "Please address these review comments from Revy:",
    "",
    ...comments.flatMap((comment, index) => {
      const range = comment.diffStartLine === comment.diffEndLine
        ? `diff line ${comment.diffStartLine + 1}`
        : `diff lines ${comment.diffStartLine + 1}-${comment.diffEndLine + 1}`;

      return [
        `## ${index + 1}. ${comment.filePath} (${range})`,
        "",
        comment.body.trim(),
        "",
      ];
    }),
  ].join("\n").trimEnd();
}

async function launchRevy(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle();

  if (!ctx.hasUI) {
    ctx.ui.notify("/revy requires interactive Pi UI", "error");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "pi-revy-"));
  const outputPath = join(dir, "comments.json");
  const configuredCommand = process.env.REVY_COMMAND;
  const command = configuredCommand ? shellWords(configuredCommand) : ["revy"];

  try {
    if (command.length === 0) {
      ctx.ui.notify("REVY_COMMAND is empty", "error");
      return;
    }

    const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _keybindings, done) => {
      tui.stop();
      process.stdout.write("\x1b[2J\x1b[H");

      const result = spawnSync(command[0]!, [...command.slice(1), "--output", outputPath], {
        cwd: ctx.cwd,
        stdio: "inherit",
        env: process.env,
      });

      tui.start();
      tui.requestRender(true);
      done(result.status ?? (result.error ? 1 : 0));
      return { render: () => [], invalidate: () => {} };
    });

    if (exitCode !== 0) {
      ctx.ui.notify(`Revy exited with code ${exitCode}`, "warning");
      return;
    }

    if (!existsSync(outputPath)) {
      ctx.ui.notify("Revy did not write a comments file", "warning");
      return;
    }

    const exported = JSON.parse(readFileSync(outputPath, "utf8")) as RevyExport;
    const promptText = formatComments(exported);

    if (!promptText) {
      ctx.ui.notify("No Revy review comments to insert", "info");
      return;
    }

    const existing = ctx.ui.getEditorText().trim();
    ctx.ui.setEditorText(existing ? `${existing}\n\n${promptText}` : promptText);
    ctx.ui.notify("Inserted Revy review comments into the prompt", "success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("revy", {
    description: "Open Revy, collect review comments, and insert them into the prompt editor",
    handler: async (_args, ctx) => launchRevy(ctx),
  });
}
