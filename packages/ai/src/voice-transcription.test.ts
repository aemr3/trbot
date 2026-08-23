import { expect, test } from "bun:test"
import {
  ApiVoiceTranscriber,
  downmixAndResampleOpus,
  encodePcmWav,
  OpenAiVoiceCredentialResolver,
  type OpenAiVoiceProviderId,
  PreferredVoiceTranscriber,
  WhisperVoiceTranscriber,
} from "./voice-transcription.ts"

test("downmixes Opus channels and resamples 48 kHz audio to the API's 16 kHz WAV rate", () => {
  const left = new Float32Array(48_000).fill(0.75)
  const right = new Float32Array(48_000).fill(0.25)

  const result = downmixAndResampleOpus([left, right])

  expect(result).toHaveLength(16_000)
  expect(result[100]).toBeCloseTo(0.5, 5)
  expect(result[15_000]).toBeCloseTo(0.5, 5)
})

test("encodes mono samples as a valid 16-bit 16 kHz PCM WAV", () => {
  const wav = encodePcmWav(new Float32Array([-1, 0, 1]))
  const view = new DataView(wav.buffer)

  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF")
  expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE")
  expect(view.getUint32(24, true)).toBe(16_000)
  expect(view.getUint16(34, true)).toBe(16)
  expect(view.getUint32(40, true)).toBe(6)
  expect(view.getInt16(44, true)).toBe(-32_768)
  expect(view.getInt16(46, true)).toBe(0)
  expect(view.getInt16(48, true)).toBe(32_767)
})

test("prefers an OpenAI API key over OpenAI Codex auth for voice transcription", async () => {
  const checked: OpenAiVoiceProviderId[] = []
  const resolved: OpenAiVoiceProviderId[] = []
  const credential = new OpenAiVoiceCredentialResolver({
    isConnected: async (providerId) => {
      checked.push(providerId)
      return true
    },
    accessToken: async (providerId) => {
      resolved.push(providerId)
      return providerId === "openai" ? "api-key" : "codex-oauth"
    },
  })

  expect(await credential.available()).toBe(true)
  expect(await credential.accessToken()).toBe("api-key")
  expect(checked).toEqual(["openai"])
  expect(resolved).toEqual(["openai"])
})

test("uses OpenAI Codex auth for voice when the API-key provider is not connected", async () => {
  const credential = new OpenAiVoiceCredentialResolver({
    isConnected: async (providerId) => providerId === "openai-codex",
    accessToken: async (providerId) => providerId === "openai-codex" ? "codex-oauth" : null,
  })

  expect(await credential.available()).toBe(true)
  expect(await credential.accessToken()).toBe("codex-oauth")
})

test("reports OpenAI voice auth unavailable when neither provider has a credential", async () => {
  const credential = new OpenAiVoiceCredentialResolver({
    isConnected: async () => false,
    accessToken: async () => null,
  })

  expect(await credential.available()).toBe(false)
  await expect(credential.accessToken()).rejects.toThrow("Connect OpenAI with an API key or connect OpenAI Codex")
})

test("uses local Whisper when OpenAI is not connected", async () => {
  let localCalls = 0
  const local = {
    transcribeOggOpus: async () => {
      localCalls += 1
      return "Local transcript"
    },
  }
  const transcriber = new PreferredVoiceTranscriber({ preferred: async () => null, fallback: local })

  expect(await transcriber.transcribeOggOpus(new Uint8Array([1]))).toBe("Local transcript")
  expect(localCalls).toBe(1)
})

test("uses OpenAI when connected without masking API failures with Whisper", async () => {
  let localCalls = 0
  const api = {
    transcribeOggOpus: async () => {
      throw new Error("API unavailable")
    },
  }
  const local = {
    transcribeOggOpus: async () => {
      localCalls += 1
      return "Local transcript"
    },
  }
  const transcriber = new PreferredVoiceTranscriber({ preferred: async () => api, fallback: local })

  await expect(transcriber.transcribeOggOpus(new Uint8Array([1]))).rejects.toThrow("API unavailable")
  expect(localCalls).toBe(0)
})

test("prepares local Whisper without inference and reuses the loaded model", async () => {
  let loads = 0
  let inferences = 0
  const transcriber = new WhisperVoiceTranscriber({}, {
    decode: async () => new Float32Array([1]),
    loadRecognizer: async () => {
      loads += 1
      return async () => {
        inferences += 1
        return " Local transcript "
      }
    },
  })

  await Promise.all([transcriber.prepare(), transcriber.prepare()])
  expect(loads).toBe(1)
  expect(inferences).toBe(0)
  expect(await transcriber.transcribeOggOpus(new Uint8Array([1]))).toBe("Local transcript")
  expect(loads).toBe(1)
  expect(inferences).toBe(1)
})

test("transcribes a Telegram voice note with gpt-transcribe and the current credential", async () => {
  const requests: Request[] = []
  const transcriber = new ApiVoiceTranscriber({ accessToken: async () => "oauth-access" }, {
    decode: async () => new Float32Array([0.25]),
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return Response.json({ text: "  Transcribed voice prompt  ", languages: [{ code: "en" }] })
    },
  })

  expect(await transcriber.transcribeOggOpus(new Uint8Array([1]))).toBe("Transcribed voice prompt")
  expect(requests).toHaveLength(1)
  expect(requests[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions")
  expect(requests[0]!.headers.get("Authorization")).toBe("Bearer oauth-access")
  const body = await requests[0]!.formData()
  expect(body.get("model")).toBe("gpt-transcribe")
  const file = body.get("file")
  if (!(file instanceof File)) throw new Error("Expected a WAV upload")
  expect(file.name).toBe("voice.wav")
  expect(file.type).toMatch(/^audio\/(?:x-)?wav$/u)
})

test("reports transcription API errors without exposing the credential", async () => {
  const transcriber = new ApiVoiceTranscriber({ accessToken: async () => "secret-access" }, {
    decode: async () => new Float32Array([0]),
    fetch: async () => Response.json({ error: { message: "The model is unavailable" } }, { status: 403 }),
  })

  const promise = transcriber.transcribeOggOpus(new Uint8Array([1]))
  await expect(promise).rejects.toThrow("HTTP 403: The model is unavailable")
  await expect(promise).rejects.not.toThrow("secret-access")
})

test("rejects empty Telegram voice data before resolving a credential", async () => {
  let credentialReads = 0
  const transcriber = new ApiVoiceTranscriber({
    accessToken: async () => {
      credentialReads += 1
      return "unused"
    },
  })

  await expect(transcriber.transcribeOggOpus(new Uint8Array())).rejects.toThrow("empty")
  expect(credentialReads).toBe(0)
})
