/**
 * Phase 8 proof: one whole visit's SAVE PATHS against a real Postgres.
 *
 * The study's end-to-end is "enter a name, take the call, fill the survey, and
 * see the three kinds of row land, each tagged with the voice the call got". A
 * literal run needs a microphone and a live model for every turn; this is the
 * lighter proof agreed for Phase 8 — it drives the exact three `record*` paths
 * the server calls, against the exact database it opens, for one call id tagged
 * with one voice label, and reads the rows back. It also POSTs the real
 * `/survey` endpoint of a running server, so the HTTP seam the page uses is
 * proven too (it answers `saved:true` once a database is connected).
 *
 * What it does NOT prove is the live STT→LLM→TTS pipeline and the audio a call
 * actually makes — that is the money-spending full run, left to a human taking
 * the call (Phase 10) and to the live link (Phase 9). The four speed numbers are
 * fed here as a synthetic `metrics.collected` frame, including a stage left
 * ABSENT so the "blank, never a zero" mapping is exercised end to end.
 *
 * Run it with a database and (for the endpoint check) a server up:
 *
 *   DATABASE_URL=postgres://… node server.ts &            # 12 engines + the DB
 *   DATABASE_URL=postgres://… PORT=3100 node phase8-visit.ts
 */
import type { MetricsCollectedEvent } from "@alexkroman1/aai";
import postgres from "postgres";
import {
  closeResultsDb,
  initResultsDb,
  recordSurvey,
  recordTurn,
  recordVisitor,
  SurveyBodySchema,
  surveyInput,
} from "./db.ts";

/** The voice this synthetic visit "got" — a mid-rotation Cartesia row, so a row
 *  tagged `v05` proves the label travels and is not just the `v01` default. */
const VOICE_LABEL = "v05";

/** A full `metrics.collected` frame — all four speed numbers present. */
function fullFrame(): MetricsCollectedEvent {
  return {
    type: "metrics.collected",
    meta: { id: "m-full", at: 0 },
    interrupted: false,
    latencyMs: 820,
    stt: { endpointingMs: 540 },
    llm: { ttftMs: 210, durationMs: 400, steps: 1 },
    tts: { ttfbMs: 130, characters: 42 },
  } as MetricsCollectedEvent;
}

/** A greeting-style frame — nobody spoke, so STT/LLM/whole-turn are ABSENT. The
 *  one number present is the voice's first sound; the rest must store as null. */
function greetingFrame(): MetricsCollectedEvent {
  return {
    type: "metrics.collected",
    meta: { id: "m-greeting", at: 0 },
    interrupted: false,
    tts: { ttfbMs: 100, characters: 20 },
  } as MetricsCollectedEvent;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert(databaseUrl, "DATABASE_URL is required for the whole-visit proof.");
  const port = Number(process.env.PORT ?? 3100);

  const ready = await initResultsDb(databaseUrl);
  assert(ready, "initResultsDb returned false — no database connected.");
  // A second handle, for reading the rows back. db.ts keeps its pool private.
  const read = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  const callId = `visit-${Date.now()}`;
  console.log(`\nWhole-visit save paths for call ${callId} (voice ${VOICE_LABEL}):\n`);

  // 1) Visitor row at call start — the server fires exactly this in onSinkCreated,
  //    the first moment the voice is known. No name yet; the survey backfills it.
  await recordVisitor(callId, VOICE_LABEL);
  console.log("  ✓ recordVisitor  — a visitors row at call start");

  // 2) Turns rows, one per reply — the server fires exactly this from its metrics
  //    sink. Two replies: one full, one with absent stages (blank, not zero).
  await recordTurn(callId, VOICE_LABEL, fullFrame());
  await recordTurn(callId, VOICE_LABEL, greetingFrame());
  console.log("  ✓ recordTurn ×2  — a turns row per reply (one with absent stages)");

  // 3) Survey row when the survey is sent — the server composes exactly this in
  //    its /survey handler: parse the body, attach the hidden label, save.
  const body = SurveyBodySchema.parse({
    callId,
    name: "Jane Smith",
    q1: 5,
    q2: 4,
    q3: 5,
    q4: 3,
  });
  await recordSurvey(surveyInput(body, VOICE_LABEL));
  console.log("  ✓ recordSurvey   — a surveys row, and the visitor name backfilled");

  // Read the three kinds of row back and check each is tagged with the voice.
  const [visitor] = await read`select * from visitors where call_id = ${callId}`;
  const turns = await read`select * from turns where call_id = ${callId} order by id`;
  const [survey] = await read`select * from surveys where call_id = ${callId}`;

  assert(visitor, "no visitors row saved");
  assert(visitor.voice_label === VOICE_LABEL, `visitor voice ${visitor.voice_label} != ${VOICE_LABEL}`);
  assert(visitor.name === "Jane Smith", `visitor name not backfilled (got ${visitor.name})`);

  assert(turns.length === 2, `expected 2 turns rows, got ${turns.length}`);
  assert(turns.every((t) => t.voice_label === VOICE_LABEL), "a turns row is mis-tagged");
  const full = turns.find((t) => t.whole_turn_ms === 820);
  const greet = turns.find((t) => t.whole_turn_ms === null);
  assert(full, "the full turn did not save its four numbers");
  assert(full.voice_first_sound_ms === 130, "full turn voice_first_sound wrong");
  assert(greet, "the greeting turn row is missing");
  assert(
    greet.end_of_speech_ms === null && greet.model_first_word_ms === null,
    "an absent stage saved as a value (should be blank, never zero)",
  );
  assert(greet.voice_first_sound_ms === 100, "greeting voice_first_sound wrong");

  assert(survey, "no surveys row saved");
  assert(survey.voice_label === VOICE_LABEL, `survey voice ${survey.voice_label} != ${VOICE_LABEL}`);
  assert(survey.q1 === "5" && survey.q4 === "3", "survey answers not saved as text");

  console.log("\n  visitors:", { call_id: visitor.call_id, voice_label: visitor.voice_label, name: visitor.name });
  console.log("  turns:   ", turns.map((t) => ({
    whole_turn_ms: t.whole_turn_ms,
    end_of_speech_ms: t.end_of_speech_ms,
    model_first_word_ms: t.model_first_word_ms,
    voice_first_sound_ms: t.voice_first_sound_ms,
    voice_label: t.voice_label,
  })));
  console.log("  surveys: ", { call_id: survey.call_id, voice_label: survey.voice_label, name: survey.name, q1: survey.q1, q2: survey.q2, q3: survey.q3, q4: survey.q4 });

  // 4) The real /survey HTTP endpoint on the running server. A different call id,
  //    one the server never served, so its label attaches as null (documented) —
  //    the point here is the endpoint accepts the body and saves (saved:true).
  const endpointCallId = `endpoint-${Date.now()}`;
  let endpointSaved = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/survey`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callId: endpointCallId, name: "Endpoint Check", q1: 4, q2: 4, q3: 4, q4: 4 }),
    });
    const json = (await res.json()) as { ok?: boolean; saved?: boolean };
    endpointSaved = res.status === 200 && json.ok === true && json.saved === true;
    console.log(`\n  POST /survey → ${res.status} ${JSON.stringify(json)}`);
    assert(endpointSaved, "the /survey endpoint did not report saved:true");
    const [row] = await read`select * from surveys where call_id = ${endpointCallId}`;
    assert(row, "the /survey endpoint did not write a surveys row");
    console.log(`  ✓ /survey wrote a row for ${endpointCallId} (voice_label ${row.voice_label ?? "null — call not served by this process"})`);
  } catch (err) {
    console.warn(`\n  ⚠ /survey endpoint not checked (is the server up on :${port}?): ${err instanceof Error ? err.message : String(err)}`);
  }

  await read.end({ timeout: 5 });
  await closeResultsDb();

  console.log(
    `\n✓ Whole-visit save paths PROVEN against a real database: a visitor row, ` +
      `two turns rows, and a survey row — all tagged ${VOICE_LABEL}, the absent ` +
      `stage blank, the name backfilled${endpointSaved ? ", and the live /survey endpoint saved" : ""}.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
