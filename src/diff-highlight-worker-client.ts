import { diffMetadataCacheKey, highlightedDiffCache, parseDiffMetadata, type HighlightedDiffCode } from "./diff-rendering"
import type { DiffHighlightFile } from "./diff-highlight.worker"

type WorkerRequest =
  | { type: "highlight"; id: string; filePath: string; diff: string }
  | { type: "enqueueFiles"; files: DiffHighlightFile[]; cwd: string }
  | { type: "dispose" }

type WorkerResponse =
  | { type: "ready" }
  | { type: "highlighted"; id?: string; filePath: string; cacheKey: string; highlighted: HighlightedDiffCode }
  | { type: "error"; id?: string; filePath?: string; message: string }

type PendingRequest = {
  resolve: (highlighted: HighlightedDiffCode) => void
  reject: (error: Error) => void
}

export type HighlightCompleteEvent = {
  filePath: string
  cacheKey: string
  highlighted: HighlightedDiffCode
}

export type DiffHighlightWorkerClient = {
  enqueueFiles(files: DiffHighlightFile[]): void
  requestHighlight(filePath: string, diff: string): Promise<HighlightedDiffCode>
  subscribe(listener: (event: HighlightCompleteEvent) => void): () => void
  dispose(): void
}

let nextRequestId = 1

function metadataCacheKey(filePath: string, diff: string): string {
  return diffMetadataCacheKey(parseDiffMetadata(diff, filePath))
}

export function startDiffHighlightWorker(options: { cwd: string }): DiffHighlightWorkerClient {
  const workerPath = import.meta.url.endsWith("/index.js") ? "./diff-highlight.worker.js" : "./diff-highlight.worker.ts"
  const worker = new Worker(new URL(workerPath, import.meta.url), { type: "module" })
  const pendingById = new Map<string, PendingRequest>()
  const inFlightByCacheKey = new Map<string, Promise<HighlightedDiffCode>>()
  const listeners = new Set<(event: HighlightCompleteEvent) => void>()
  let disposed = false

  function post(message: WorkerRequest): void {
    if (!disposed) worker.postMessage(message)
  }

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data
    if (message.type === "ready") return

    if (message.type === "highlighted") {
      highlightedDiffCache.set(message.cacheKey, message.highlighted)
      for (const listener of listeners) {
        listener({ filePath: message.filePath, cacheKey: message.cacheKey, highlighted: message.highlighted })
      }
      if (message.id) {
        const pending = pendingById.get(message.id)
        pendingById.delete(message.id)
        pending?.resolve(message.highlighted)
      }
      return
    }

    if (message.type === "error" && message.id) {
      const pending = pendingById.get(message.id)
      pendingById.delete(message.id)
      pending?.reject(new Error(message.message))
    }
  }

  worker.onerror = (event) => {
    const error = new Error(event.message)
    for (const pending of pendingById.values()) pending.reject(error)
    pendingById.clear()
    inFlightByCacheKey.clear()
  }

  return {
    enqueueFiles(files) {
      post({ type: "enqueueFiles", files, cwd: options.cwd })
    },

    requestHighlight(filePath, diff) {
      const cacheKey = metadataCacheKey(filePath, diff)
      const cached = highlightedDiffCache.get(cacheKey)
      if (cached) return Promise.resolve(cached)

      const inFlight = inFlightByCacheKey.get(cacheKey)
      if (inFlight) return inFlight

      const id = String(nextRequestId++)
      const promise = new Promise<HighlightedDiffCode>((resolve, reject) => {
        pendingById.set(id, { resolve, reject })
        post({ type: "highlight", id, filePath, diff })
      }).finally(() => {
        inFlightByCacheKey.delete(cacheKey)
      })

      inFlightByCacheKey.set(cacheKey, promise)
      return promise
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose() {
      disposed = true
      post({ type: "dispose" })
      worker.terminate()
      for (const pending of pendingById.values()) pending.reject(new Error("Diff highlight worker disposed"))
      pendingById.clear()
      inFlightByCacheKey.clear()
      listeners.clear()
    },
  }
}
