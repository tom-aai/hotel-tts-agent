import type { TtsProvider } from "@alexkroman1/aai";
import type { ProviderCredentialOptions } from "@alexkroman1/aai/tts";

/**
 * ElevenLabs TTS — the DESCRIPTOR half (Phase 3, the one provider we build).
 *
 * The toolkit ships speaking support for AssemblyAI, Cartesia and Rime only, so
 * ElevenLabs is the part we add ourselves. It splits the same way every shipped
 * provider does, and for the same reason: this file is PURE — a factory that
 * returns `{ kind, options }` data and reads no key and opens no socket — so
 * `voices.ts` (and through it the agent bundle) can import it without dragging a
 * WebSocket or any host code into the guest. The HOST half — the thing that
 * opens the connection and hands back sound — lives in `elevenlabs-tts-host.ts`
 * and is registered with `registerTtsKind` by the server (Phases 4/8). Until
 * that registration runs in a process, an `elevenlabs` descriptor is inert data.
 *
 * {@link resolveElevenLabsTtsSettings} is the one place the descriptor's options
 * meet their host-side defaults, shared by the factory's callers and the opener
 * so the settings reported are by construction the ones dialled.
 */

/** Kind tag the host-side resolver matches — see `registerElevenLabsTts`. */
export const ELEVENLABS_TTS_KIND = "elevenlabs";

/** Agent-env variable the ElevenLabs API key is read from at session start. */
export const ELEVENLABS_API_KEY_ENV = "ELEVENLABS_API_KEY";

/**
 * Default model. Flash v2.5 is ElevenLabs' low-latency streaming model — the
 * right default for a voice agent, and the one this study times speed against.
 */
export const ELEVENLABS_DEFAULT_MODEL = "eleven_flash_v2_5";

/**
 * Default voice (Jessica), used only when a caller names none. `voices.ts`
 * always passes a voice, so this is a safety net, not the study's choice.
 */
export const ELEVENLABS_DEFAULT_VOICE = "cgSgspJ2msm6clMCkdW9";

/** Options for {@link elevenLabsTts}. Mirrors the Cartesia descriptor's shape. */
export interface ElevenLabsTtsOptions extends ProviderCredentialOptions {
  /** ElevenLabs voice id. Defaults to {@link ELEVENLABS_DEFAULT_VOICE}. */
  voice?: string;
  /** Model id. Defaults to {@link ELEVENLABS_DEFAULT_MODEL}. */
  model?: string;
  /**
   * Spoken-language hint (ISO 639-1), sent as the `language_code` query param.
   * Omitted by default — the multilingual flash model auto-detects.
   */
  language?: string;
}

/**
 * Build an ElevenLabs TTS descriptor for pipeline mode — a pure `{ kind,
 * options }` value. The API key is resolved host-side from the agent's env
 * (`ELEVENLABS_API_KEY`) when the opener this kind registers is opened.
 */
export function elevenLabsTts(options: ElevenLabsTtsOptions = {}): TtsProvider {
  const opts: Record<string, unknown> = {};
  if (options.voice !== undefined) opts.voice = options.voice;
  if (options.model !== undefined) opts.model = options.model;
  if (options.language !== undefined) opts.language = options.language;
  if (options.apiKeyEnv !== undefined) opts.apiKeyEnv = options.apiKeyEnv;
  return { kind: ELEVENLABS_TTS_KIND, options: opts };
}

/** The descriptor's options with every host-side default filled in. */
export function resolveElevenLabsTtsSettings(options: ElevenLabsTtsOptions): {
  voice: string;
  model: string;
  language: string | undefined;
} {
  return {
    voice: options.voice ?? ELEVENLABS_DEFAULT_VOICE,
    model: options.model ?? ELEVENLABS_DEFAULT_MODEL,
    language: options.language,
  };
}
