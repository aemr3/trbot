import type {
  ExperimentRunOptions,
  ReinforcementExperimentResult,
} from "./experiment.ts"

export type ExperimentWorkerOptions = Omit<ExperimentRunOptions, "signal" | "onProgress">

export type ExperimentWorkerRequest =
  | { type: "RUN"; runId: string; options: ExperimentWorkerOptions }
  | { type: "CANCEL"; runId: string }

export type ExperimentWorkerResponse =
  | {
      type: "PROGRESS"
      runId: string
      progress: Parameters<NonNullable<ExperimentRunOptions["onProgress"]>>[0]
    }
  | { type: "RESULT"; runId: string; result: ReinforcementExperimentResult }
  | { type: "ERROR"; runId: string; error: SerializedWorkerError }

export interface SerializedWorkerError {
  name: string
  message: string
  stack?: string
}
