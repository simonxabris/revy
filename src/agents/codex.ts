import { Codex } from "@openai/codex-sdk"
import { ReviewAgent, type AgentProviderModelOption, type ReviewFixRequest } from "./types"
import { buildReviewFixPrompt } from "./prompt"

export class CodexAgent extends ReviewAgent {
  readonly id = "codex"
  readonly label = "Codex"

  async listProviderModels(_repoRoot: string): Promise<AgentProviderModelOption[]> {
    return [{
      agent: this.id,
      agentLabel: this.label,
      provider: { id: "codex", label: "Codex" },
      model: { id: "gpt-5.5", label: "GPT-5.5" },
    }]
  }

  async fixReviewComments(request: ReviewFixRequest): Promise<void> {
    if (request.provider && request.provider !== "codex") {
      throw new Error(`Codex does not support provider ${request.provider}`)
    }

    const codex = new Codex()
    const thread = codex.startThread({
      workingDirectory: request.repoRoot,
      model: request.model,
    })

    await thread.run(buildReviewFixPrompt(request))
  }
}
