import { createOpencode } from "@opencode-ai/sdk"
import { ReviewAgent, type AgentProviderModelOption, type ReviewFixRequest } from "./types"
import { buildReviewFixPrompt } from "./prompt"

export class OpencodeAgent extends ReviewAgent {
  readonly id = "opencode"
  readonly label = "opencode"

  async listProviderModels(repoRoot: string): Promise<AgentProviderModelOption[]> {
    const opencode = await createOpencode()

    try {
      const response = await opencode.client.provider.list({
        throwOnError: true,
        query: { directory: repoRoot },
      })

      const connectedProviders = new Set(response.data.connected)

      return response.data.all
        .filter((provider) => connectedProviders.has(provider.id))
        .flatMap((provider) =>
          Object.values(provider.models).map((model) => ({
            agent: this.id,
            agentLabel: this.label,
            provider: { id: provider.id, label: provider.name },
            model: { id: model.id, label: model.name },
          })),
        )
    } finally {
      opencode.server.close()
    }
  }

  async fixReviewComments(request: ReviewFixRequest): Promise<void> {
    const opencode = await createOpencode()

    try {
      const session = await opencode.client.session.create({
        throwOnError: true,
        query: { directory: request.repoRoot },
        body: { title: "Fix review comments" },
      })

      await opencode.client.session.prompt({
        throwOnError: true,
        path: { id: session.data.id },
        query: { directory: request.repoRoot },
        body: {
          model: request.provider && request.model ? {
            providerID: request.provider,
            modelID: request.model,
          } : undefined,
          parts: [
            {
              type: "text",
              text: buildReviewFixPrompt(request),
            },
          ],
        },
      })
    } finally {
      opencode.server.close()
    }
  }
}
