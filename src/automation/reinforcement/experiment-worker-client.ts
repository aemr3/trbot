import type {
  ExperimentRunOptions,
  ReinforcementExperimentResult,
} from "./experiment.ts"
import type {
  ExperimentWorkerRequest,
  ExperimentWorkerResponse,
  SerializedWorkerError,
} from "./experiment-worker-protocol.ts"

export function runWalkForwardExperimentInWorker(
  options: ExperimentRunOptions,
): Promise<ReinforcementExperimentResult> {
  if (options.signal?.aborted) return Promise.reject(abortError())

  const worker = new Worker(new URL("./experiment-worker.ts", import.meta.url).href) as Worker & { unref(): void }
  worker.unref()
  const runId = crypto.randomUUID()

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: ReinforcementExperimentResult | null, error?: unknown): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener("abort", cancel)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      if (error !== undefined) reject(error)
      else resolve(result!)
    }
    const cancel = (): void => {
      worker.postMessage({ type: "CANCEL", runId } satisfies ExperimentWorkerRequest)
    }

    worker.onmessage = (event: MessageEvent<ExperimentWorkerResponse>): void => {
      const response = event.data
      if (response.runId !== runId) return
      if (response.type === "PROGRESS") options.onProgress?.(response.progress)
      else if (response.type === "RESULT") finish(response.result)
      else finish(null, deserializeError(response.error))
    }
    worker.onerror = (event): void => {
      finish(null, new Error(event.message || "Reinforcement experiment worker failed"))
    }
    options.signal?.addEventListener("abort", cancel, { once: true })

    const { signal: _signal, onProgress: _onProgress, ...workerOptions } = options
    worker.postMessage({ type: "RUN", runId, options: workerOptions } satisfies ExperimentWorkerRequest)
  })
}

function deserializeError(error: SerializedWorkerError): Error {
  if (error.name === "AbortError") return abortError(error.message)
  const value = new Error(error.message)
  value.name = error.name
  if (error.stack) value.stack = error.stack
  return value
}

function abortError(message = "Reinforcement experiment cancelled"): DOMException {
  return new DOMException(message, "AbortError")
}
