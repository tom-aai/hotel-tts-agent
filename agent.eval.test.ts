/** The def a DEPLOYED agent runs: authored, plus what `tools/` and the prompt add. */
import agentDef from "virtual:aai/agent";
// An EVAL for the voice-study desk: does the MODEL stay on the fixed booking
// script?
//
// `agent.test.ts` drives the dialog directly — it proves the script's states
// advance in order and that every turn is speak-only. What no direct test can
// settle is whether the live model, handed a real caller, actually walks the
// script to the end and reads each detail back. That is what this file is for.
// The agent has no tools, so "stayed on the script" is simply "called nothing".
//
// Run it with `aai eval`. Without a provider key every case runs against a
// SCRIPTED model (its `stubReply`), which still boots this agent and still
// applies the dialog's speak-only gate — so a stub run proves the wiring and
// proves nothing about what the agent chose.
import {
  describeToolCalls,
  toolCallsInTurns,
  toolNames,
} from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";

describeEval(agentDef, (test) => {
  test(
    "the desk walks the fixed booking script and never reaches for a tool",
    async ({ session }) => {
      // A whole call, caller turn by caller turn: ready, the name spelled, the
      // night, the address, the confirmation, and how they are. The script reads
      // each thing back and ends with the "you're a regular, it's on us" turn —
      // all of it SPEECH, so the claim is simply that no tool was ever called.
      const turns = await session.sayAll([
        "Yes, I'm ready to book.",
        "It's Jane Smith — S, M, I, T, H.",
        "This Friday night, please.",
        "Twelve Harbor Road, Portland.",
        "Yes, that's exactly right.",
        "I'm doing really well, thanks for asking.",
      ]);
      const calls = toolCallsInTurns(turns);

      // The pinned script is speak-only at every step, so a call that stayed on
      // it touched no tool at all.
      expect(toolNames(calls), describeToolCalls(calls)).toEqual([]);
      // And it ran to the end — the goodbye turn completed.
      expect(turns.at(-1)?.completed).toBe(true);
    },
    {
      stubReply: [
        "Wonderful - may I have your name, and could you spell your last name for me?",
        "Thank you, Jane Smith - that's S, M, I, T, H. Which night would you like to stay?",
        "Friday night, lovely. I'll take payment now - first, what's your address?",
        "Twelve Harbor Road, Portland - have I got that right?",
        "Oh - you're Jane Smith from Portland! We know you - you're one of our regulars, and we " +
          "already have your card on file. How are you doing today, Jane?",
        "Wonderful to hear. This night is on us, completely free, and we look forward to seeing " +
          "you on Friday. Take care - goodbye!",
      ],
    },
  );
});
