/** The def a DEPLOYED agent runs: authored, plus what the prompt adds. */
import agentDef from "virtual:aai/agent";
import type { SessionEvent, ToolContext } from "@alexkroman1/aai";
import { createToolContext } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import { deskFlow } from "./desk.ts";

// The simplified voice-study agent: no tools, no booking state machine, no hotel
// domain. Its whole behaviour is the fixed eight-step booking script in
// `desk.ts`, driven one turn at a time by the caller's replies. So these specs
// cover exactly two things — that the deployed agent is that shape, and that the
// script's states advance in order and stay speak-only.

// ─── Harness ─────────────────────────────────────────────────────────────────

/** What the runtime offers the desk dialog when the caller says something. */
const HEARD_SOMETHING: SessionEvent = {
  type: "user-transcript.committed",
  text: "yes, that's right",
  meta: { id: "evt_1", at: 0 },
};

/** And when they hang up (or the idle watchdog fires). */
const CALLER_GONE: SessionEvent = { type: "session.timed-out", meta: { id: "evt_2", at: 0 } };

/** Where the call is, without going through a tool. */
const at = (ctx: ToolContext) => deskFlow.position(ctx).state;

/** The caller answers — their next committed turn is what advances the script. */
const callerAnswers = (ctx: ToolContext) => deskFlow.receive(ctx, HEARD_SOMETHING).state;

// ─── The deployed agent's shape ──────────────────────────────────────────────

describe("the deployed agent", () => {
  test("is the Harborlight desk, opening on the booking question", () => {
    expect(agentDef.name).toBe("The Harborlight Hotel");
    expect(agentDef.greeting).toMatch(/book a room/i);
  });

  test("carries no tools — the whole call is the script, never a tool call", () => {
    expect(Object.keys(agentDef.tools)).toEqual([]);
  });

  test("runs exactly one dialog: the fixed booking script", () => {
    expect(agentDef.dialogs).toHaveLength(1);
    expect(agentDef.dialogs?.[0]).toBe(deskFlow);
  });
});

// ─── The fixed booking script ────────────────────────────────────────────────

describe("the fixed booking script", () => {
  // The eight steps of docs/tts-preference-plan.md, one agent turn per state.
  // Step 1 (hello + "ready to book?") is the agent.ts greeting, before the
  // dialog; the script opens on the caller's answer to it and runs to goodbye.
  const SCRIPT = [
    "call.ready",
    "call.readName",
    "call.readNight",
    "call.readAddress",
    "call.theTwist",
    "call.farewell",
  ] as const;

  test("a fresh call opens on the first step, speaking only", () => {
    const ctx = createToolContext();
    expect(at(ctx)).toBe("call.ready");
    expect(deskFlow.voiceConfig(ctx)?.toolChoice).toBe("none");
  });

  test("each caller turn advances one step, in order, through to the goodbye", () => {
    const ctx = createToolContext();
    const walked = [at(ctx)];
    for (let i = 1; i < SCRIPT.length; i++) walked.push(callerAnswers(ctx));
    expect(walked).toEqual(SCRIPT);
  });

  test("every speaking turn hands the model no tools, so the script cannot wander into one", () => {
    const ctx = createToolContext();
    for (const state of SCRIPT) {
      expect(at(ctx)).toBe(state);
      expect(deskFlow.voiceConfig(ctx)?.toolChoice, state).toBe("none");
      if (state !== SCRIPT.at(-1)) callerAnswers(ctx);
    }
  });

  test("the read-back turns ask for a steady voice; the opener and the goodbye leave it default", () => {
    const ctx = createToolContext();
    // ready (the opener): no temperature override.
    expect(deskFlow.voiceConfig(ctx)?.temperature).toBeUndefined();
    // The four read-back turns — a spelled name, a night, an address, the
    // name-and-city twist — each ask for the steadier voice.
    for (const steady of ["call.readName", "call.readNight", "call.readAddress", "call.theTwist"]) {
      expect(callerAnswers(ctx)).toBe(steady);
      expect(deskFlow.voiceConfig(ctx)?.temperature, steady).toBe(0.2);
    }
    // farewell (the goodbye): nothing to read back, so back to the default.
    expect(callerAnswers(ctx)).toBe("call.farewell");
    expect(deskFlow.voiceConfig(ctx)?.temperature).toBeUndefined();
  });

  test("the goodbye is the end: farewell is final and a further turn does not run past it", () => {
    const ctx = createToolContext();
    for (let i = 1; i < SCRIPT.length; i++) callerAnswers(ctx);
    expect(at(ctx)).toBe("call.farewell");
    expect(callerAnswers(ctx)).toBe("call.farewell");
  });

  test("a hang-up mid-script ends the call on hungUp, and nothing advances after", () => {
    const ctx = createToolContext();
    callerAnswers(ctx);
    expect(at(ctx)).toBe("call.readName");
    expect(deskFlow.receive(ctx, CALLER_GONE).state).toBe("hungUp");
    // The caller is gone; a stray transcript cannot restart the script.
    expect(callerAnswers(ctx)).toBe("hungUp");
  });
});
