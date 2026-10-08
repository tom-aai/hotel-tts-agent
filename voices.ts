import type { TtsProvider } from "@alexkroman1/aai";
import { assemblyAITts, cartesiaTts } from "@alexkroman1/aai/tts";
import { elevenLabsTts } from "./elevenlabs-tts.ts";

/**
 * The twelve voices under study — four each from AssemblyAI, Cartesia and
 * ElevenLabs — and the one file you edit to add, drop or swap one.
 *
 * This is a seam the parallel sessions agreed on (see the build plan): a row is
 * `{ label, provider, voice }`, the `label` (`v01`…`v12`) is the HIDDEN tag the
 * server records for a call and never sends to the page, and `voice` is whatever
 * the provider names a voice by — an AssemblyAI catalog name, or a Cartesia /
 * ElevenLabs voice id. The human name beside each row is a comment, not a field:
 * it is for us reading the list, and keeping it out of the row keeps the seam the
 * three sessions share down to the three agreed keys.
 *
 * {@link ttsForRow} turns a row into the `tts` descriptor `agent()` wants. All
 * three providers resolve here now: AssemblyAI and Cartesia ship with the
 * toolkit, and Phase 3 added the ElevenLabs connector (`elevenlabs-tts.ts` for
 * the descriptor, `elevenlabs-tts-host.ts` for the opener). Every descriptor is
 * pure data; an `elevenlabs` one only SPEAKS once the host registers its opener
 * with `registerElevenLabsTts` (the server does this — Phases 4/8).
 */
export type VoiceProvider = "assemblyai" | "cartesia" | "elevenlabs";

/** One voice: its hidden label, who speaks it, and how that provider names it. */
export interface VoiceRow {
  /** `v01`…`v12` — the hidden label recorded per call; never reaches the page. */
  readonly label: string;
  readonly provider: VoiceProvider;
  /** AssemblyAI catalog name, or a Cartesia / ElevenLabs voice id. */
  readonly voice: string;
}

/**
 * The twelve rows, in label order. AssemblyAI voices are catalog NAMES (lower
 * case — the catalog is case-sensitive and a name it does not list goes silent
 * after the socket opens); Cartesia and ElevenLabs voices are ids, because a
 * wrong id fails the same silent way and a name is not something to guess.
 */
export const VOICES: readonly VoiceRow[] = [
  // AssemblyAI — names from the shipped catalog (all US-accent English).
  { label: "v01", provider: "assemblyai", voice: "jane" }, // Jane
  { label: "v02", provider: "assemblyai", voice: "alba" }, // Alba
  { label: "v03", provider: "assemblyai", voice: "george" }, // George
  { label: "v04", provider: "assemblyai", voice: "mary" }, // Mary
  // Cartesia — voice ids from the account's current voice list.
  { label: "v05", provider: "cartesia", voice: "a167e0f3-df7e-4d52-a9c3-f949145efdab" }, // Blake
  { label: "v06", provider: "cartesia", voice: "5c5ad5e7-1020-476b-8b91-fdcbe9cc313c" }, // Daniela
  { label: "v07", provider: "cartesia", voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc" }, // Jacqueline
  { label: "v08", provider: "cartesia", voice: "f31cc6a7-c1e8-4764-980c-60a361443dd1" }, // Robyn
  // ElevenLabs — voice ids; not resolvable until Phase 3 registers the connector.
  { label: "v09", provider: "elevenlabs", voice: "cgSgspJ2msm6clMCkdW9" }, // Jessica
  { label: "v10", provider: "elevenlabs", voice: "DXFkLCBUTmvXpp2QwZjA" }, // Eryn
  { label: "v11", provider: "elevenlabs", voice: "GogJbMCDT0Viv4cU3N4s" }, // Andre Rene
  { label: "v12", provider: "elevenlabs", voice: "ZoiZ8fuDWInAcwPXaVeq" }, // Josh
];

/** The row carrying a given label, or `undefined` if no row has it. */
export function voiceByLabel(label: string): VoiceRow | undefined {
  return VOICES.find((row) => row.label === label);
}

/**
 * Turn a voice row into the `tts` descriptor `agent({ tts })` takes.
 *
 * Each factory returns a pure descriptor (no socket, no key read) that the host
 * resolves at session start. AssemblyAI and Cartesia ship with the toolkit;
 * ElevenLabs is the provider Phase 3 built, so its descriptor is ours but has
 * the same shape — the host turns it into sound once `registerElevenLabsTts` has
 * run (the server does this, Phases 4/8).
 */
export function ttsForRow(row: VoiceRow): TtsProvider {
  switch (row.provider) {
    case "assemblyai":
      return assemblyAITts({ voice: row.voice });
    case "cartesia":
      return cartesiaTts({ voice: row.voice });
    case "elevenlabs":
      return elevenLabsTts({ voice: row.voice });
  }
}
