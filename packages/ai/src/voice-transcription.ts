import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers"
import { OggOpusDecoder } from "ogg-opus-decoder"
import { z } from "zod"

const OPUS_SAMPLE_RATE = 48_000
const TRANSCRIPTION_SAMPLE_RATE = 16_000
const DOWNSAMPLE_FACTOR = OPUS_SAMPLE_RATE / TRANSCRIPTION_SAMPLE_RATE
const LOW_PASS_TAPS = createLowPassFilter(31, 0.15)
const TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions"
const DEFAULT_MODEL = "gpt-transcribe"
const DEFAULT_LOCAL_MODEL = "onnx-community/whisper-small"
const REQUEST_TIMEOUT_MS = 2 * 60_000
const OPENAI_VOICE_PROVIDER_IDS = ["openai", "openai-codex"] as const

const TranscriptionResponseSchema = z.object({ text: z.string() }).loose()
const ErrorResponseSchema = z.object({
  error: z.object({ message: z.string() }).loose(),
}).loose()

type FetchRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Recognizer = (audio: Float32Array) => Promise<string>

export interface VoiceTranscriber {
  transcribeOggOpus(audio: Uint8Array): Promise<string>
}

export type OpenAiVoiceProviderId = typeof OPENAI_VOICE_PROVIDER_IDS[number]

export interface OpenAiVoiceAuthSource {
  isConnected(providerId: OpenAiVoiceProviderId): Promise<boolean>
  accessToken(providerId: OpenAiVoiceProviderId): Promise<string | null>
}

/** Resolves only credentials that may authenticate requests to OpenAI's audio API. */
export class OpenAiVoiceCredentialResolver {
  constructor(private readonly source: OpenAiVoiceAuthSource) {}

  async available(): Promise<boolean> {
    for (const providerId of OPENAI_VOICE_PROVIDER_IDS) {
      if (await this.source.isConnected(providerId)) return true
    }
    return false
  }

  async accessToken(): Promise<string> {
    for (const providerId of OPENAI_VOICE_PROVIDER_IDS) {
      const token = await this.source.accessToken(providerId)
      if (token) return token
    }
    throw new Error("Connect OpenAI with an API key or connect OpenAI Codex before using voice transcription")
  }
}

export interface PreferredVoiceTranscriberOptions {
  preferred: () => Promise<VoiceTranscriber | null>
  fallback: VoiceTranscriber
}

/** Selects the preferred transcriber per message, falling back only when it is unavailable. */
export class PreferredVoiceTranscriber implements VoiceTranscriber {
  constructor(private readonly options: PreferredVoiceTranscriberOptions) {}

  async transcribeOggOpus(audio: Uint8Array): Promise<string> {
    const preferred = await this.options.preferred()
    return await (preferred ?? this.options.fallback).transcribeOggOpus(audio)
  }
}

export interface ApiVoiceTranscriberOptions {
  accessToken: () => Promise<string>
  model?: string
}

export interface ApiVoiceTranscriberDependencies {
  decode?: (audio: Uint8Array) => Promise<Float32Array>
  fetch?: FetchRequest
}

/** Decodes Telegram voice notes locally, then transcribes their WAV audio through the configured model API. */
export class ApiVoiceTranscriber implements VoiceTranscriber {
  private readonly decode: (audio: Uint8Array) => Promise<Float32Array>
  private readonly request: FetchRequest

  constructor(
    private readonly options: ApiVoiceTranscriberOptions,
    dependencies: ApiVoiceTranscriberDependencies = {},
  ) {
    this.decode = dependencies.decode ?? decodeOggOpus
    this.request = dependencies.fetch ?? globalThis.fetch
  }

  async transcribeOggOpus(audio: Uint8Array): Promise<string> {
    if (audio.byteLength === 0) throw new Error("The voice message is empty")

    const samples = await this.decode(audio)
    const token = await this.options.accessToken()
    if (!token) throw new Error("The voice transcription credential is unavailable")

    const form = new FormData()
    form.set("model", this.options.model ?? DEFAULT_MODEL)
    form.set("file", new Blob([encodePcmWav(samples)], { type: "audio/wav" }), "voice.wav")
    const response = await this.request(TRANSCRIPTION_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const error = ErrorResponseSchema.safeParse(payload)
      const detail = error.success ? `: ${error.data.error.message}` : ""
      throw new Error(`Voice transcription API returned HTTP ${response.status}${detail}`)
    }

    const result = TranscriptionResponseSchema.safeParse(payload)
    if (!result.success) throw new Error("Voice transcription API returned an invalid response")
    return result.data.text.trim()
  }
}

export interface WhisperVoiceTranscriberOptions {
  model?: string
  cacheDir?: string
}

export interface WhisperVoiceTranscriberDependencies {
  decode?: (audio: Uint8Array) => Promise<Float32Array>
  loadRecognizer?: () => Promise<Recognizer>
}

/** Lazily loads the local Whisper fallback and serializes inference to bound memory use. */
export class WhisperVoiceTranscriber implements VoiceTranscriber {
  private readonly decode: (audio: Uint8Array) => Promise<Float32Array>
  private readonly loadRecognizer: () => Promise<Recognizer>
  private recognizer: Promise<Recognizer> | null = null
  private pending: Promise<void> = Promise.resolve()

  constructor(
    options: WhisperVoiceTranscriberOptions = {},
    dependencies: WhisperVoiceTranscriberDependencies = {},
  ) {
    this.decode = dependencies.decode ?? decodeOggOpus
    this.loadRecognizer = dependencies.loadRecognizer
      ?? (() => loadWhisperRecognizer(options.model ?? DEFAULT_LOCAL_MODEL, options.cacheDir))
  }

  /** Downloads and loads the model without running inference. Concurrent calls share one load. */
  async prepare(): Promise<void> {
    await this.requireRecognizer()
  }

  transcribeOggOpus(audio: Uint8Array): Promise<string> {
    if (audio.byteLength === 0) return Promise.reject(new Error("The voice message is empty"))

    const operation = this.pending.then(async () => {
      const samples = await this.decode(audio)
      const recognizer = await this.requireRecognizer()
      return (await recognizer(samples)).trim()
    })
    this.pending = operation.then(() => undefined, () => undefined)
    return operation
  }

  private requireRecognizer(): Promise<Recognizer> {
    if (!this.recognizer) {
      const loading = this.loadRecognizer()
      this.recognizer = loading
      void loading.catch(() => {
        if (this.recognizer === loading) this.recognizer = null
      })
    }
    return this.recognizer
  }
}

async function loadWhisperRecognizer(
  model: string,
  cacheDir: string | undefined,
): Promise<Recognizer> {
  const { pipeline } = await import("@huggingface/transformers")
  const transcriber: AutomaticSpeechRecognitionPipeline = await pipeline(
    "automatic-speech-recognition",
    model,
    {
      device: "cpu",
      dtype: "q8",
      cache_dir: cacheDir,
    },
  )
  return async (audio) => {
    const result = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: "en",
      task: "transcribe",
    })
    return result.text
  }
}

async function decodeOggOpus(audio: Uint8Array): Promise<Float32Array> {
  const decoder = new OggOpusDecoder()
  try {
    await decoder.ready
    const decoded = await decoder.decodeFile(audio)
    if (decoded.errors.length > 0) throw new Error(decoded.errors[0]!.message)
    if (decoded.samplesDecoded === 0 || decoded.channelData.length === 0) {
      throw new Error("The voice message contains no audio samples")
    }
    return downmixAndResampleOpus(decoded.channelData)
  } finally {
    decoder.free()
  }
}

/** Encodes normalized mono samples as a 16-bit, 16 kHz PCM WAV upload. */
export function encodePcmWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytesPerSample = 2
  const dataLength = samples.length * bytesPerSample
  const output = new Uint8Array(44 + dataLength)
  const view = new DataView(output.buffer)
  writeAscii(output, 0, "RIFF")
  view.setUint32(4, 36 + dataLength, true)
  writeAscii(output, 8, "WAVE")
  writeAscii(output, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TRANSCRIPTION_SAMPLE_RATE, true)
  view.setUint32(28, TRANSCRIPTION_SAMPLE_RATE * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeAscii(output, 36, "data")
  view.setUint32(40, dataLength, true)

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]!))
    const pcm = Math.round(sample < 0 ? sample * 32_768 : sample * 32_767)
    view.setInt16(44 + index * bytesPerSample, pcm, true)
  }
  return output
}

function writeAscii(output: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    output[offset + index] = value.charCodeAt(index)
  }
}

/** Converts the decoder's 48 kHz channels into the mono 16 kHz input uploaded to transcription. */
export function downmixAndResampleOpus(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) throw new Error("The voice message contains no audio channels")
  const sampleCount = Math.min(...channels.map((channel) => channel.length))
  if (sampleCount === 0) return new Float32Array()

  const output = new Float32Array(Math.floor(sampleCount / DOWNSAMPLE_FACTOR))
  const halfFilter = Math.floor(LOW_PASS_TAPS.length / 2)
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const center = outputIndex * DOWNSAMPLE_FACTOR
    let filtered = 0
    for (let tapIndex = 0; tapIndex < LOW_PASS_TAPS.length; tapIndex += 1) {
      const inputIndex = center + tapIndex - halfFilter
      if (inputIndex < 0 || inputIndex >= sampleCount) continue
      let mono = 0
      for (const channel of channels) mono += channel[inputIndex]!
      filtered += (mono / channels.length) * LOW_PASS_TAPS[tapIndex]!
    }
    output[outputIndex] = filtered
  }
  return output
}

/** Windowed-sinc low-pass filter used before exact 3:1 decimation. */
function createLowPassFilter(length: number, cutoff: number): Float32Array {
  const taps = new Float32Array(length)
  const midpoint = (length - 1) / 2
  let total = 0
  for (let index = 0; index < length; index += 1) {
    const offset = index - midpoint
    const sinc = offset === 0
      ? 2 * cutoff
      : Math.sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset)
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1))
    taps[index] = sinc * window
    total += taps[index]!
  }
  for (let index = 0; index < taps.length; index += 1) taps[index] = taps[index]! / total
  return taps
}
