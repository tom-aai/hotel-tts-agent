import { describe, expect, test } from "vitest";
import { ttsForRow, VOICES, voiceByLabel, type VoiceRow } from "./voices.ts";

/**
 * The list is a shared seam (the server reads it, the survey borrows its labels),
 * so these pin the shape the other sessions rely on, and that all twelve rows —
 * four AssemblyAI, four Cartesia, four ElevenLabs — turn into a TTS descriptor
 * of the right kind. ElevenLabs became resolvable in Phase 3, which built its
 * connector and extended `ttsForRow`.
 */
describe("the voices list", () => {
  test("is twelve rows, four per provider, labelled v01..v12 in order", () => {
    expect(VOICES).toHaveLength(12);
    expect(VOICES.map((v) => v.label)).toEqual([
      "v01", "v02", "v03", "v04", "v05", "v06",
      "v07", "v08", "v09", "v10", "v11", "v12",
    ]);
    const byProvider = (p: VoiceRow["provider"]) =>
      VOICES.filter((v) => v.provider === p);
    expect(byProvider("assemblyai")).toHaveLength(4);
    expect(byProvider("cartesia")).toHaveLength(4);
    expect(byProvider("elevenlabs")).toHaveLength(4);
  });

  test("has unique labels and unique voices", () => {
    expect(new Set(VOICES.map((v) => v.label)).size).toBe(12);
    expect(new Set(VOICES.map((v) => v.voice)).size).toBe(12);
  });

  test("voiceByLabel finds a row, or undefined for an unknown label", () => {
    expect(voiceByLabel("v05")?.voice).toBe("a167e0f3-df7e-4d52-a9c3-f949145efdab");
    expect(voiceByLabel("v99")).toBeUndefined();
  });
});

describe("ttsForRow", () => {
  test("turns the four AssemblyAI rows into assemblyai TTS descriptors", () => {
    for (const row of VOICES.filter((v) => v.provider === "assemblyai")) {
      const tts = ttsForRow(row);
      expect(tts.kind).toBe("assemblyai");
      expect(tts.options.voice).toBe(row.voice);
    }
  });

  test("turns the four Cartesia rows into cartesia TTS descriptors", () => {
    for (const row of VOICES.filter((v) => v.provider === "cartesia")) {
      const tts = ttsForRow(row);
      expect(tts.kind).toBe("cartesia");
      expect(tts.options.voice).toBe(row.voice);
    }
  });

  test("turns the four ElevenLabs rows into elevenlabs TTS descriptors", () => {
    for (const row of VOICES.filter((v) => v.provider === "elevenlabs")) {
      const tts = ttsForRow(row);
      expect(tts.kind).toBe("elevenlabs");
      expect(tts.options.voice).toBe(row.voice);
    }
  });
});
