/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import {
  ChatView,
  Form,
  type FormValues,
  mountClient,
  SelectField,
  SidebarLayout,
  SubmitButton,
  TextField,
  useAgentState,
  useSession,
} from "@alexkroman1/aai-ui";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { type DeskView, deskView, emptyHotelState } from "./shared.ts";

/**
 * The study's one screen — Phase 7 of `docs/tts-preference-build-plan.md`.
 *
 * A visit is three screens in a row on the same page: a NAME GATE, the hotel
 * CALL, and then the SURVEY. The two new ones book-end the call the repo already
 * ships, and both are assembled from the `@alexkroman1/aai-ui` form pieces — no
 * new form kit, per the concept plan ("The screen — we reuse the one we already
 * have").
 *
 * - **Name gate.** The Start control stays off until a name is entered. The name
 *   is held here and carried on the survey POST, where the server backfills it
 *   onto the call's `visitors` row (see `db.ts`'s `recordSurvey`). Because the
 *   SERVER picks the voice, the browser never sends — or sees — a voice label.
 * - **Call.** Once started, the shipped `ChatView` and the hotel `DeskSidebar`
 *   below, unchanged.
 * - **Survey.** When the call ends — `started` flips back to `false`, which is
 *   what `end()` and a server hang-up both do — the four Likert questions appear
 *   and POST to `/survey` as `{ callId, name, q1..q4 }`, the shared contract the
 *   server's handler reads. The hidden voice label is attached there, keyed by
 *   the call id.
 *
 * The call id is the session id. The browser learns it from the server's config
 * frame via `mountClient`'s `onSessionId`, which feeds the tiny store below so a
 * component can read it; it is the thread that ties this visit's survey row to
 * the voice the server chose.
 */

// ---------------------------------------------------------------------------
// The call id, learned from the server and read by the survey.
// ---------------------------------------------------------------------------

let currentCallId: string | null = null;
const callIdListeners = new Set<() => void>();

/** Fed by `mountClient`'s `onSessionId` — the one place the id arrives. */
function setCurrentCallId(id: string): void {
  currentCallId = id;
  for (const listener of callIdListeners) listener();
}

/** The current call id, or `null` before the server has sent one. */
function useCallId(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      callIdListeners.add(onChange);
      return () => callIdListeners.delete(onChange);
    },
    () => currentCallId,
    () => currentCallId,
  );
}

// ---------------------------------------------------------------------------
// The four questions.
// ---------------------------------------------------------------------------

/**
 * The four Likert statements, in order (concept plan, "The four questions"). All
 * four are worded so that agreeing is the good answer, so a higher number is
 * better on every one.
 */
const QUESTIONS: readonly { name: "q1" | "q2" | "q3" | "q4"; statement: string }[] = [
  { name: "q1", statement: "The voice agent sounded natural." },
  { name: "q2", statement: "The voice agent spoke in the tone and speed of a real person." },
  { name: "q3", statement: "The voice agent always correctly pronounced commonly known names." },
  { name: "q4", statement: "The voice agent always correctly pronounced numbers and abbreviations." },
];

/** The five points of the agree/disagree scale, worst (1) to best (5). */
const SCALE: readonly { value: string; label: string }[] = [
  { value: "1", label: "1 — Strongly disagree" },
  { value: "2", label: "2 — Disagree" },
  { value: "3", label: "3 — Neither agree nor disagree" },
  { value: "4", label: "4 — Agree" },
  { value: "5", label: "5 — Strongly agree" },
];

// ---------------------------------------------------------------------------
// The three screens.
// ---------------------------------------------------------------------------

/** A centered card on the themed page — the frame the gate and the survey share. */
function CenterCard({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-aai-bg p-4 text-aai-text">
      <div className="flex w-full max-w-md flex-col gap-6 rounded-2xl bg-aai-surface p-6 shadow-lg sm:p-8">
        {children}
      </div>
    </main>
  );
}

/**
 * The name gate. The Start control is disabled until a name is entered; a bare
 * `<form>` with a `required` field also blocks an empty submit, so the Enter key
 * and the button agree. `onStart` hands the trimmed name up and begins the call.
 */
function NameGate({ onStart }: { onStart: (name: string) => void }) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  return (
    <CenterCard>
      <header className="flex flex-col gap-2">
        <h1 className="text-balance text-2xl font-bold">The Harborlight Hotel</h1>
        <p className="text-pretty text-sm leading-relaxed opacity-70">
          You'll book a room with our front desk, then answer four quick questions about how the
          voice sounded. Enter your name to begin.
        </p>
      </header>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed !== "") onStart(trimmed);
        }}
      >
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Your name
          <input
            autoFocus
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Dana"
            className="rounded-lg border border-aai-border bg-aai-bg px-3 py-2 text-base text-aai-text outline-none focus:border-aai-primary"
          />
        </label>
        <button
          type="submit"
          disabled={trimmed === ""}
          className="rounded-lg bg-aai-primary px-4 py-2.5 text-base font-semibold text-aai-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          Start call
        </button>
      </form>
    </CenterCard>
  );
}

/**
 * The four-question survey, shown once the call ends. Built from the shipped
 * `Form`/`SelectField`/`SubmitButton` and POSTed to `/survey` as the shared
 * `{ callId, name, q1..q4 }` body. The answers go over as numbers 1..5.
 */
function Survey({
  name,
  callId,
  onDone,
}: {
  name: string;
  callId: string;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | undefined>(undefined);

  async function submit(values: FormValues) {
    setError(undefined);
    try {
      const response = await fetch("/survey", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          callId,
          name,
          q1: Number(values.q1),
          q2: Number(values.q2),
          q3: Number(values.q3),
          q4: Number(values.q4),
        }),
      });
      if (!response.ok) throw new Error(`server answered ${response.status}`);
      onDone();
    } catch (cause) {
      setError(
        `Sorry, we couldn't save your answers (${
          cause instanceof Error ? cause.message : String(cause)
        }). Please try again.`,
      );
    }
  }

  return (
    <CenterCard>
      <header className="flex flex-col gap-2">
        <h1 className="text-balance text-2xl font-bold">How did that sound?</h1>
        <p className="text-pretty text-sm leading-relaxed opacity-70">
          Thanks, {name}. Four quick questions about the voice you just heard.
        </p>
      </header>
      <Form onSubmit={submit} error={error} className="flex flex-col gap-5">
        {QUESTIONS.map((question) => (
          <SelectField
            key={question.name}
            name={question.name}
            label={question.statement}
            defaultValue=""
            required
          >
            {/* An empty, un-choosable default so `required` blocks a submit until
                the caller actually picks a point on the scale. */}
            <option value="" disabled>
              Choose…
            </option>
            {SCALE.map((point) => (
              <option key={point.value} value={point.value}>
                {point.label}
              </option>
            ))}
          </SelectField>
        ))}
        <SubmitButton>Send answers</SubmitButton>
      </Form>
    </CenterCard>
  );
}

// ---------------------------------------------------------------------------
// The hotel desk sidebar — reused from the shipped screen, unchanged.
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-bold uppercase tracking-wider opacity-60">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="opacity-60">{label}</span>
      <span className={value === null ? "opacity-40 italic" : "text-right font-medium"}>
        {value ?? "pending"}
      </span>
    </div>
  );
}

const KIND_LABELS: Record<DeskView["ledger"][number]["kind"], string> = {
  followup: "Followup",
  wakeup_call: "Wake-up call",
  do_not_disturb: "Do not disturb",
  waitlist: "Waitlist",
  tour: "Tour",
  spa: "Spa",
  business_center: "Business centre",
  flowers: "Florist",
  email: "Email",
  transfer: "Transfer",
  flight_reconfirmation: "Flight",
  airport_car: "Hotel car",
  emergency: "EMERGENCY",
  guest_message: "Guest message",
  group_inquiry: "Group inquiry",
  walk: "Walk",
};

// The desk before the first tool call, derived from the projection itself so a
// new DeskView field can't miss the pre-first-call render.
//
// **This template does NOT pass its projection to `useAgentState`**, and the
// reason is the browser bundle rather than style: that overload derives the
// empty frame by calling the projection, which calls the slot's `create()` —
// and this slot's factory lives in `session.ts` and pulls `seed.ts`, so
// importing it here would ship every seeded booking to the browser.
// `emptyHotelState()` is the same shape without the seed. Reach for the
// projection overload everywhere the factory is cheap.
const EMPTY_VIEW: DeskView = deskView(emptyHotelState());

function DeskSidebar() {
  const desk = useAgentState<DeskView>(EMPTY_VIEW);
  return (
    <div className="flex flex-col gap-6 p-4 text-aai-text">
      <Section title="Tonight">
        <Row label="In house" value={String(desk.inHouse)} />
        <Row label="Arriving today" value={String(desk.arrivingToday)} />
      </Section>

      <Section title="Verified guest">
        {desk.verified ? (
          <div className="rounded-lg bg-aai-surface p-3 flex flex-col gap-1">
            <Row label="Guest" value={desk.verified.name} />
            <Row label="Booking" value={desk.verified.code} />
            <Row label="Room" value={desk.verified.room} />
            <Row label="Stay" value={desk.verified.stay} />
            <Row label="Status" value={desk.verified.status} />
          </div>
        ) : (
          <p className="text-sm opacity-50">No one verified on this call.</p>
        )}
      </Section>

      <Section
        title={desk.draft?.mode === "modify" ? "Modifying a booking" : "Booking in progress"}
      >
        {desk.draft ? (
          <div className="rounded-lg bg-aai-surface p-3 flex flex-col gap-1">
            <Row label="Stay" value={desk.draft.stay} />
            <Row label="Room" value={desk.draft.room} />
            <Row label="Extras" value={desk.draft.extras} />
            <Row label="Guest" value={desk.draft.guest} />
            <Row label="Card" value={desk.draft.card} />
            <Row label="Total" value={desk.draft.total} />
          </div>
        ) : (
          <p className="text-sm opacity-50">No booking flow open.</p>
        )}
      </Section>

      <Section title="Written this call">
        {desk.ledger.length === 0 ? (
          <p className="text-sm opacity-50">Nothing yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {desk.ledger.map((t) => (
              <li
                key={t.code}
                className="rounded-lg bg-aai-surface p-2 text-xs flex flex-col gap-0.5"
              >
                <div className="flex justify-between gap-2">
                  <span
                    className={
                      t.kind === "emergency"
                        ? "font-bold text-red-400"
                        : "font-bold text-aai-primary"
                    }
                  >
                    {KIND_LABELS[t.kind]}
                  </span>
                  <span className="opacity-60 font-mono">{t.code}</span>
                </div>
                <span className="opacity-80">{t.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The app: name gate → call → survey, in order.
// ---------------------------------------------------------------------------

/** Which of the three screens a visit is on. */
type Phase = "gate" | "call" | "survey" | "done";

function StudyApp() {
  const session = useSession();
  const callId = useCallId();
  const [name, setName] = useState("");
  // The call id this visit's survey will carry. Latched when the server sends it
  // and kept after `end()` clears the live one, so the survey of the just-ended
  // call still has its id.
  const [surveyCallId, setSurveyCallId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("gate");

  // The id this visit's survey will carry. Latch it as soon as the server sends
  // it, so it survives `end()` clearing the live session into the survey screen.
  useEffect(() => {
    if (phase === "call" && callId !== null) setSurveyCallId(callId);
  }, [phase, callId]);

  // Deciding the call is OVER is the subtle part. The shipped controls only
  // pause/resume (Stop/Resume) and clear (New Conversation) — none calls `end()`,
  // and a dialog reaching its `final` state stops the agent talking without
  // closing the socket. So "the call is live, now it is not" is ambiguous:
  // `state === "disconnected"` is equally a pause. The reliable signal is an
  // EXPLICIT end, which the "End call & rate the voice" button below is — it calls
  // `session.end()` and advances here. The one non-deliberate end we still honour
  // is a FATAL error (a dropped call): the caller should still get to rate what
  // they heard rather than being stranded on a dead chat view.
  const fatal = session.error?.fatal ?? false;
  useEffect(() => {
    if (phase === "call" && fatal && (surveyCallId ?? callId) !== null) {
      setPhase("survey");
    }
  }, [phase, fatal, surveyCallId, callId]);

  if (phase === "gate") {
    return (
      <NameGate
        onStart={(entered) => {
          setName(entered);
          setSurveyCallId(null);
          setPhase("call");
          session.start();
        }}
      />
    );
  }

  if (phase === "call") {
    const haveId = (surveyCallId ?? callId) !== null;
    return (
      <SidebarLayout sidebar={<DeskSidebar />} sidebarWidth="22rem">
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1">
            <ChatView />
          </div>
          <footer className="flex justify-center border-t border-aai-border bg-aai-surface p-3">
            <button
              type="button"
              disabled={!haveId}
              onClick={() => {
                session.end();
                setPhase("survey");
              }}
              className="rounded-lg bg-aai-primary px-4 py-2.5 text-base font-semibold text-aai-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            >
              End call &amp; rate the voice
            </button>
          </footer>
        </div>
      </SidebarLayout>
    );
  }

  if (phase === "survey") {
    const id = surveyCallId ?? callId;
    // `id` is non-null here: the call phase disables End until an id exists and
    // the fatal-error path checks for one. The guard satisfies the compiler and
    // is a safe fallback if that ever changes.
    if (id === null) {
      setPhase("gate");
      return null;
    }
    return <Survey name={name} callId={id} onDone={() => setPhase("done")} />;
  }

  return (
    <CenterCard>
      <header className="flex flex-col gap-2">
        <h1 className="text-balance text-2xl font-bold">Thank you</h1>
        <p className="text-pretty text-sm leading-relaxed opacity-70">
          Your answers are saved. Thanks for helping us choose a voice, {name}.
        </p>
      </header>
      <button
        type="button"
        onClick={() => {
          setName("");
          setSurveyCallId(null);
          setPhase("gate");
        }}
        className="rounded-lg bg-aai-primary px-4 py-2.5 text-base font-semibold text-aai-bg"
      >
        Take another call
      </button>
    </CenterCard>
  );
}

mountClient({
  component: StudyApp,
  name: "The Harborlight Hotel",
  onSessionId: setCurrentCallId,
  theme: {
    bg: "#101418",
    primary: "#c8a96e",
    text: "#f2ede4",
    surface: "#1a2026",
    border: "#2a323b",
  },
});
