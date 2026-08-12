import { runWalkForwardExperiment } from "./experiment.ts"
import type {
  ExperimentWorkerRequest,
  ExperimentWorkerResponse,
  SerializedWorkerError,
} from "./experiment-worker-protocol.ts"

declare const self: Worker

let activeRun: { id: string; controller: AbortController } | null = null

self.onmessage = (event: MessageEvent<ExperimentWorkerRequest>): void => {
  const request = event.data
  if (request.type === "CANCEL") {
    if (activeRun?.id === request.runId) activeRun.controller.abort()
    return
  }

  if (activeRun) {
    post({
      type: "ERROR",
      runId: request.runId,
      error: { name: "Error", message: "Reinforcement experiment worker is already running" },
    })
    return
  }

  const controller = new AbortController()
  activeRun = { id: request.runId, controller }
  void runWalkForwardExperiment({
    ...request.options,
    signal: controller.signal,
    onProgress: (progress) => post({ type: "PROGRESS", runId: request.runId, progress }),
  }).then(
    (result) => post({ type: "RESULT", runId: request.runId, result }),
    (error) => post({ type: "ERROR", runId: request.runId, error: serializeError(error) }),
  ).finally(() => {
    if (activeRun?.id === request.runId) activeRun = null
  })
}

function post(response: ExperimentWorkerResponse): void {
  self.postMessage(response)
}

function serializeError(error: unknown): SerializedWorkerError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    }
  }
  return { name: "Error", message: String(error) }
}
