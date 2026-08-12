import type { ReinforcementReplayEpisode } from "./replay.ts"

export interface ReinforcementDataset {
  episodes: ReinforcementReplayEpisode[]
  skippedInputs: number
}

export interface ReinforcementDatasetSource {
  load(): Promise<ReinforcementDataset>
}
