import { describe, expect, test } from "vitest";
import {
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_DEFAULT_VOICE,
  ELEVENLABS_TTS_KIND,
  elevenLabsTts,
  resolveElevenLabsTtsSettings,
} from "./elevenlabs-tts.ts";

/**
 * The DESCRIPTOR half of the Phase 3 connector — pure, so these run offline in
 * the ordinary suite. The live proof that the four engines actually speak is
 * `elevenlabs-smoke.ts`, which spends money and needs the key, so it is a script
 * rather than a spec.
 */
describe("elevenLabsTts", () => {
  test("returns an inert `elevenlabs` descriptor carrying only the set options", () => {
    const tts = elevenLabsTts({ voice: "v-id" });
    expect(tts.kind).toBe(ELEVENLABS_TTS_KIND);
    expect(tts.options).toEqual({ voice: "v-id" });
  });

  test("threads model, language and an apiKeyEnv override through verbatim", () => {
    const tts = elevenLabsTts({
      voice: "v-id",
      model: "eleven_turbo_v2_5",
      language: "en",
      apiKeyEnv: "ELEVENLABS_API_KEY_STAGING",
    });
    expect(tts.options).toEqual({
      voice: "v-id",
      model: "eleven_turbo_v2_5",
      language: "en",
      apiKeyEnv: "ELEVENLABS_API_KEY_STAGING",
    });
  });

  test("omits unset options rather than writing undefined", () => {
    const tts = elevenLabsTts();
    expect(tts.options).toEqual({});
    expect("voice" in tts.options).toBe(false);
  });

  test("names the ELEVENLABS_API_KEY env var the opener reads", () => {
    expect(ELEVENLABS_API_KEY_ENV).toBe("ELEVENLABS_API_KEY");
  });
});

describe("resolveElevenLabsTtsSettings", () => {
  test("fills the host-side defaults when the descriptor names none", () => {
    expect(resolveElevenLabsTtsSettings({})).toEqual({
      voice: ELEVENLABS_DEFAULT_VOICE,
      model: ELEVENLABS_DEFAULT_MODEL,
      language: undefined,
    });
  });

  test("prefers the descriptor's own options over the defaults", () => {
    expect(resolveElevenLabsTtsSettings({ voice: "v-id", model: "m", language: "fr" })).toEqual({
      voice: "v-id",
      model: "m",
      language: "fr",
    });
  });
});
