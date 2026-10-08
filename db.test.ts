import type { MetricsCollectedEvent } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import {
  recordSurvey,
  recordTurn,
  recordVisitor,
  resultsDbReady,
  SurveyBodySchema,
  surveyInput,
  turnTimings,
} from "./db.ts";

/**
 * Phase 6's pure shaping, tested offline. The database itself (a live Postgres)
 * is proven in Phase 8's whole-visit run; here we pin the two things that would
 * save WRONG rows if they regressed: the metric→turn mapping (a blank, never a
 * zero, for a stage that did not happen) and the survey body parse. We also check
 * that every save path is an inert no-op with no database connected, which is what
 * lets `npm run dev` run without one.
 */

function metrics(overrides: Partial<MetricsCollectedEvent>): MetricsCollectedEvent {
  return {
    type: "metrics.collected",
    meta: { id: "m1", at: 0 },
    interrupted: false,
    ...overrides,
  } as MetricsCollectedEvent;
}

describe("turnTimings", () => {
  test("maps the four numbers off a full frame", () => {
    const t = turnTimings(
      metrics({
        latencyMs: 820,
        stt: { endpointingMs: 540 },
        llm: { ttftMs: 210, durationMs: 400, steps: 1 },
        tts: { ttfbMs: 130, characters: 42 },
      }),
    );
    expect(t).toEqual({
      wholeTurnMs: 820,
      endOfSpeechMs: 540,
      modelFirstWordMs: 210,
      voiceFirstSoundMs: 130,
      interrupted: false,
    });
  });

  test("a stage that did not happen is null, never zero", () => {
    // A greeting: nobody spoke (no STT), nothing was said back by the caller.
    const t = turnTimings(metrics({ tts: { ttfbMs: 100, characters: 20 } }));
    expect(t.endOfSpeechMs).toBeNull();
    expect(t.modelFirstWordMs).toBeNull();
    expect(t.wholeTurnMs).toBeNull();
    expect(t.voiceFirstSoundMs).toBe(100);
  });

  test("carries the interrupted flag through", () => {
    expect(turnTimings(metrics({ interrupted: true })).interrupted).toBe(true);
  });
});

describe("the survey body contract", () => {
  test("accepts { callId, name, q1..q4 } and coerces answers to text", () => {
    const parsed = SurveyBodySchema.parse({
      callId: "call-1",
      name: "Ada",
      q1: 5,
      q2: "clear",
      q3: true,
      q4: "yes",
    });
    const row = surveyInput(parsed, "v07");
    expect(row).toEqual({
      callId: "call-1",
      voiceLabel: "v07",
      name: "Ada",
      q1: "5",
      q2: "clear",
      q3: "true",
      q4: "yes",
    });
  });

  test("a missing answer or name saves as null, and a blank name trims to null", () => {
    const parsed = SurveyBodySchema.parse({ callId: "call-2", name: "  " });
    const row = surveyInput(parsed, null);
    expect(row.name).toBeNull();
    expect(row.voiceLabel).toBeNull();
    expect(row.q1).toBeNull();
    expect(row.q4).toBeNull();
  });

  test("rejects a body with no call id", () => {
    expect(SurveyBodySchema.safeParse({ name: "Ada" }).success).toBe(false);
    expect(SurveyBodySchema.safeParse({ callId: "" }).success).toBe(false);
  });
});

describe("without a database connected", () => {
  test("nothing is connected and every save path is an inert no-op", async () => {
    expect(resultsDbReady()).toBe(false);
    // None of these touch a pool, so none should throw.
    await expect(recordVisitor("call-3", "v01")).resolves.toBeUndefined();
    await expect(
      recordSurvey(surveyInput(SurveyBodySchema.parse({ callId: "call-3" }), "v01")),
    ).resolves.toBeUndefined();
    await expect(
      recordTurn("call-3", "v01", metrics({ latencyMs: 100 })),
    ).resolves.toBeUndefined();
  });
});
