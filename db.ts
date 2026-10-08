/**
 * The results database for the voice-preference study (Phase 6 of
 * `docs/tts-preference-build-plan.md`).
 *
 * The study asks one question — which of twelve voices do callers prefer — and
 * answering it means keeping three kinds of row that outlive a call and can be
 * counted per voice later: who showed up and what voice they got (`visitors`),
 * what they said about it afterwards (`surveys`), and how fast each reply was
 * (`turns`). Every row carries the voice label, so every query is "group by
 * voice" with no join.
 *
 * ## Bring-your-own client
 *
 * The toolkit provisions no database and hands tool code none (the SDK guide,
 * "Persisting data — bring your own client"), so this owns a Postgres pool of
 * its own, opened once from `DATABASE_URL`. The server calls {@link initResultsDb}
 * at boot and the three `record*` paths from the places a row is born. Without a
 * URL the pool is never opened and every `record*` is a no-op, so `npm run dev`
 * and a bare `node server.ts` still run — the same graceful absence the server
 * already warns about.
 *
 * ## The schema lives here, in one place
 *
 * {@link ensureSchema} is the "one setup file" the plan asks for: three
 * `create table if not exists` statements, run on first connect, idempotent so a
 * redeploy against an existing database is a no-op. There is no migration tool to
 * learn — the study's shape is small and fixed.
 *
 * ## Blanks, never zeroes, for a step that did not happen
 *
 * A reply's four speed numbers are each OPTIONAL at the source (`metrics.collected`
 * marks an absent stage absent, not zero, because a zero averages in as the fast
 * case). {@link turnTimings} carries that straight through to `null`, and the
 * columns are nullable, so a missing number is a blank in the row — never a
 * zero a dashboard would believe.
 */
import type { MetricsCollectedEvent } from "@alexkroman1/aai";
import postgres from "postgres";
import { z } from "zod";

/** The one pool, opened by {@link initResultsDb}; `undefined` until then. */
type Sql = ReturnType<typeof postgres>;
let sql: Sql | undefined;

/** Whether a results database is connected — false under `dev` with no URL. */
export function resultsDbReady(): boolean {
  return sql !== undefined;
}

/**
 * Open the pool from `databaseUrl` and create the three tables. Answers whether a
 * database was connected: `false` (and nothing opened) when the URL is absent, so
 * the caller can log the same graceful-absence note it logs for session state.
 */
export async function initResultsDb(
  databaseUrl: string | undefined,
): Promise<boolean> {
  if (!databaseUrl) return false;
  // `onnotice` silenced: `create table if not exists` emits a NOTICE for a table
  // that already exists, which is the normal redeploy case and not worth a line.
  sql = postgres(databaseUrl, { max: 5, onnotice: () => {} });
  await ensureSchema(sql);
  return true;
}

/** Close the pool on shutdown. Idempotent. */
export async function closeResultsDb(): Promise<void> {
  const open = sql;
  sql = undefined;
  if (open) await open.end({ timeout: 5 });
}

/**
 * The three tables, created if absent. Each row carries `voice_label` so the
 * study's every question is a group-by with no join; `created_at` orders them.
 */
async function ensureSchema(db: Sql): Promise<void> {
  // One person who entered a name and started a call, with the voice they got.
  // Keyed by the call id, so a resume of the same call does not double-count.
  await db`
    create table if not exists visitors (
      call_id    text primary key,
      voice_label text not null,
      name       text,
      created_at timestamptz not null default now()
    )
  `;
  // One finished survey. `name` and the four answers are whatever the page sent;
  // `voice_label` is the hidden label the server attached, null if the call was
  // never recorded (a survey for a call this process did not serve).
  await db`
    create table if not exists surveys (
      id         bigint generated always as identity primary key,
      call_id    text not null,
      voice_label text,
      name       text,
      q1         text,
      q2         text,
      q3         text,
      q4         text,
      created_at timestamptz not null default now()
    )
  `;
  // One reply, for speed. The four numbers are nullable on purpose: a blank, not
  // a zero, where that stage did not happen in this reply (see this file's head).
  await db`
    create table if not exists turns (
      id                   bigint generated always as identity primary key,
      call_id              text not null,
      voice_label          text,
      whole_turn_ms        integer,
      end_of_speech_ms     integer,
      model_first_word_ms  integer,
      voice_first_sound_ms integer,
      interrupted          boolean not null,
      created_at           timestamptz not null default now()
    )
  `;
}

/**
 * Save a `visitors` row at call start. `on conflict do nothing` so a resume of
 * the same call (same id, same voice) is idempotent rather than an error. The
 * name is filled later, from the survey — see {@link recordSurvey}.
 */
export async function recordVisitor(
  callId: string,
  voiceLabel: string,
): Promise<void> {
  if (!sql) return;
  await sql`
    insert into visitors (call_id, voice_label)
    values (${callId}, ${voiceLabel})
    on conflict (call_id) do nothing
  `;
}

/**
 * The survey body the page POSTs to `/survey`, per the shared contract in the
 * build plan: `{ callId, name, q1, q2, q3, q4 }`. The hidden voice label is NOT
 * here — the server attaches it from the call id. Answers are coerced to text so
 * a numeric rating and a typed sentence store the same way; a missing one is
 * left out and saved as null.
 */
const answer = z
  .union([z.string(), z.number(), z.boolean()])
  .transform(String)
  .nullable()
  .optional();

export const SurveyBodySchema = z.object({
  callId: z.string().min(1),
  name: z.string().optional(),
  q1: answer,
  q2: answer,
  q3: answer,
  q4: answer,
});

export type SurveyBody = z.infer<typeof SurveyBodySchema>;

/** A `surveys` row ready to save: the parsed body plus the attached voice label. */
export interface SurveyInput {
  callId: string;
  voiceLabel: string | null;
  name: string | null;
  q1: string | null;
  q2: string | null;
  q3: string | null;
  q4: string | null;
}

/**
 * Shape a parsed body and the voice label the server looked up into a row. Pure,
 * so the mapping (trimmed name, `undefined` answers as null) is unit-tested
 * offline. A blank name trims to null rather than an empty string.
 */
export function surveyInput(
  body: SurveyBody,
  voiceLabel: string | null,
): SurveyInput {
  const name = body.name?.trim();
  return {
    callId: body.callId,
    voiceLabel,
    name: name ? name : null,
    q1: body.q1 ?? null,
    q2: body.q2 ?? null,
    q3: body.q3 ?? null,
    q4: body.q4 ?? null,
  };
}

/**
 * Save a `surveys` row when the survey is sent, and backfill the visitor's name
 * from it (the name gate is Phase 7; until it saves a name at call start, the
 * survey is where a visitor's name first reaches us). The backfill only fills a
 * blank, so a name saved earlier is never overwritten.
 */
export async function recordSurvey(input: SurveyInput): Promise<void> {
  if (!sql) return;
  await sql`
    insert into surveys (call_id, voice_label, name, q1, q2, q3, q4)
    values (
      ${input.callId}, ${input.voiceLabel}, ${input.name},
      ${input.q1}, ${input.q2}, ${input.q3}, ${input.q4}
    )
  `;
  if (input.name !== null) {
    await sql`
      update visitors set name = ${input.name}
      where call_id = ${input.callId} and name is null
    `;
  }
}

/** One reply's four speed numbers, each `null` where that stage did not happen. */
export interface TurnTimings {
  /** Committed caller turn → first reply audio (the whole turn). */
  wholeTurnMs: number | null;
  /** Last partial with words → committed final (the end-of-speech pause). */
  endOfSpeechMs: number | null;
  /** Request → the model's first content part (the model's first word). */
  modelFirstWordMs: number | null;
  /** First text into TTS → its first audio (the voice's first sound). */
  voiceFirstSoundMs: number | null;
  /** Whether the reply was cut short. */
  interrupted: boolean;
}

/**
 * Pull the four numbers the study keeps out of a `metrics.collected` frame,
 * mapping an absent stage to `null` (never zero). The transcription-delay number
 * the old plan flagged is deliberately not among them. Pure, so the mapping is
 * tested offline.
 */
export function turnTimings(event: MetricsCollectedEvent): TurnTimings {
  return {
    wholeTurnMs: event.latencyMs ?? null,
    endOfSpeechMs: event.stt?.endpointingMs ?? null,
    modelFirstWordMs: event.llm?.ttftMs ?? null,
    voiceFirstSoundMs: event.tts?.ttfbMs ?? null,
    interrupted: event.interrupted,
  };
}

/** Save a `turns` row per reply, with the voice label the call is on. */
export async function recordTurn(
  callId: string,
  voiceLabel: string | null,
  event: MetricsCollectedEvent,
): Promise<void> {
  if (!sql) return;
  const t = turnTimings(event);
  await sql`
    insert into turns (
      call_id, voice_label,
      whole_turn_ms, end_of_speech_ms, model_first_word_ms, voice_first_sound_ms,
      interrupted
    )
    values (
      ${callId}, ${voiceLabel},
      ${t.wholeTurnMs}, ${t.endOfSpeechMs}, ${t.modelFirstWordMs}, ${t.voiceFirstSoundMs},
      ${t.interrupted}
    )
  `;
}
