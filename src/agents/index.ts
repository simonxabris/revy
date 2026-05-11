import { CodexAgent } from "./codex"
import { OpencodeAgent } from "./opencode"
import { ReviewAgent, type AgentId, type AgentProviderModelOption, type ReviewFixRequest } from "./types"

export { CodexAgent } from "./codex"
export { OpencodeAgent } from "./opencode"
export { ReviewAgent }
export type { AgentId, AgentModel, AgentProvider, AgentProviderModelOption, ReviewFixComment, ReviewFixRequest } from "./types"

const agents = {
  codex: new CodexAgent(),
  opencode: new OpencodeAgent(),
} satisfies Record<AgentId, ReviewAgent>

export const availableAgents = Object.values(agents)

export function getAgent(agentId: AgentId): ReviewAgent {
  return agents[agentId]
}

export async function listProviderModels(repoRoot: string): Promise<AgentProviderModelOption[]> {
  const results = await Promise.allSettled(availableAgents.map((agent) => agent.listProviderModels(repoRoot)))
  const options = results.flatMap((result) => result.status === "fulfilled" ? result.value : [])

  if (options.length === 0) {
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : [])
    throw new Error(errors.join("\n") || "No agent models available")
  }

  return options
}

export async function dispatchReviewFix(request: ReviewFixRequest): Promise<void> {
  if (request.comments.length === 0) {
    throw new Error("Cannot dispatch review fix without comments")
  }

  const agent = getAgent(request.agent)
  await agent.fixReviewComments(request)
}
