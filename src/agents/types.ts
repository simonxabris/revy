export type AgentId = "codex" | "opencode"

export interface ReviewFixComment {
  id: string
  filePath: string
  diffStartLine: number
  diffEndLine: number
  body: string
}

export interface AgentProvider {
  id: string
  label: string
}

export interface AgentModel {
  id: string
  label: string
}

export interface AgentProviderModelOption {
  agent: AgentId
  agentLabel: string
  provider: AgentProvider
  model: AgentModel
}

export interface ReviewFixRequest {
  agent: AgentId
  repoRoot: string
  comments: ReviewFixComment[]
  provider?: string
  model?: string
}

export abstract class ReviewAgent {
  abstract readonly id: AgentId
  abstract readonly label: string

  abstract listProviderModels(repoRoot: string): Promise<AgentProviderModelOption[]>
  abstract fixReviewComments(request: ReviewFixRequest): Promise<void>
}
