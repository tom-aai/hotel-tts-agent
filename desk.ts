/**
 * The CALL, as a dialog — the fixed booking script every caller hears.
 *
 * This is the voice-study version of the Harborlight desk. The repo's open-ended
 * receptionist (dozens of tools, a full booking state machine) is gone from the
 * conversation on purpose: the study compares twelve voices, so every caller has
 * to hear the SAME words in the SAME order, or the voice is not what is being
 * judged. See `docs/tts-preference-plan.md`, "What the call itself does".
 *
 * So the flow is a straight line of speak-only turns, one state per agent turn:
 *
 * | step (concept plan) | state | what the agent says this turn |
 * | --- | --- | --- |
 * | 1. hello + "ready to book?" | — | the `greeting` in `agent.ts`, before the dialog |
 * | 2. ask name, spell last name | `ready` | asks for the name and the spelling |
 * | 3. read name back + ask the night | `readName` | spells the last name back, asks which night |
 * | 4. read night back + ask address | `readNight` | reads the night back, asks for the address |
 * | 6. read address back + confirm | `readAddress` | reads the address back, asks them to confirm |
 * | 7. "you're a regular, it's on us" | `theTwist` | the twist, then asks how they are |
 * | 8. free night + goodbye | `farewell` | the night is free, goodbye — `final` |
 *
 * The hinge between every turn is the caller's reply: each state declares one
 * transition on `@user-transcript.committed` to the next. That is the same seam
 * the old `offering`/`readBack` states used — an obligation to SPEAK is
 * discharged by the caller's next turn, which no tool call can observe but a
 * session event can — applied to the whole script rather than two moments of it.
 *
 * Two voice knobs ride on the states, for the same reasons the old desk used
 * them:
 *
 * - **`toolChoice: "none"` on every speaking state.** The study's other hotel
 *   tools still exist in `tools/` (verification, the restaurant, concierge), but
 *   the pinned script must never reach for one: a caller question answered by a
 *   policy lookup would be a different call, and a different call is a different
 *   voice test. Removing every tool for the turn leaves the model only the
 *   sentence the state describes.
 * - **`temperature: 0.2` on the read-back turns.** Reading a spelled name, a
 *   night and an address back is transcription, and the failure those turns have
 *   is a model smoothing one letter or number into another — exactly the slip
 *   the study is built to catch, so the model's own voice should not add to it.
 */

import type { AnyDialog, ToolChoice } from "@alexkroman1/aai";
import { dialog } from "@alexkroman1/aai";

/**
 * Every script turn is the model SAYING one thing and nothing else.
 *
 * Named once because all six speaking states carry the same rule, and typed
 * {@link ToolChoice} because a bare `"none"` would widen to `string` and stop
 * being checked against the four values the field admits.
 */
const SPEAK_ONLY: ToolChoice = "none";

/** The read-backs want a steady voice — see the module comment. */
const STEADY = 0.2;

const deskSpec = {
  initial: "call",
  states: {
    /**
     * The whole script, wrapped so the hang-up is declared ONCE: a caller who
     * drops at any step bubbles `@session.timed-out` up to here and lands on
     * `hungUp`, final, so a model talking to a dead line says nothing more.
     */
    call: {
      initial: "ready",
      on: { "@session.timed-out": "hungUp" },
      states: {
        // Step 2. The greeting already asked if they are ready to book; they
        // have just answered. Get the name, and the spelling in the same breath.
        ready: {
          toolChoice: SPEAK_ONLY,
          instruction:
            "The caller has just said whether they are ready to book a room. Warmly ask for " +
            "their full name, and in the SAME turn ask them to spell their last name letter by " +
            "letter. One short, friendly line - do not take any other detail yet.",
          on: { "@user-transcript.committed": "readName" },
        },
        // Step 3, and the start of step 4. Read the name back - spelled - and
        // ask which night, which is the next thing to read back.
        readName: {
          toolChoice: SPEAK_ONLY,
          temperature: STEADY,
          instruction:
            "Repeat the caller's full name back, and spell their last name back letter by " +
            "letter, exactly as they gave it. Then ask which single night they would like to " +
            "stay. One or two short sentences.",
          on: { "@user-transcript.committed": "readNight" },
        },
        // Step 4 read-back, and step 5. Read the night back, then pivot to
        // "payment" - whose first and only step, by design, is the address.
        readNight: {
          toolChoice: SPEAK_ONLY,
          temperature: STEADY,
          instruction:
            "Repeat the night the caller named back to them, exactly as they said it. Then say " +
            "you will take payment now, and the first thing you need is their address - ask for " +
            "their full street address. One short line. Do not ask for a card.",
          on: { "@user-transcript.committed": "readAddress" },
        },
        // Step 6. Read the address back and have them confirm it.
        readAddress: {
          toolChoice: SPEAK_ONLY,
          temperature: STEADY,
          instruction:
            "Repeat the caller's address back to them in full, then ask them to confirm it is " +
            "correct. One short line.",
          on: { "@user-transcript.committed": "theTwist" },
        },
        // Step 7. The twist: you know them, you have their card, no payment is
        // taken. Then ask, by first name, how they are - the turn they answer.
        theTwist: {
          toolChoice: SPEAK_ONLY,
          temperature: STEADY,
          instruction:
            "Now the warm twist. Say: oh - you're [their full name] from [the city in the " +
            "address they just gave]! We know you - you're one of our regulars, and we already " +
            "have your card on file. Then ask, by their first name, how they are doing today. " +
            "Take NO payment and ask for no card. One or two short sentences.",
          on: { "@user-transcript.committed": "farewell" },
        },
        // Step 8. The night is free; see you then; goodbye. The call is done.
        farewell: {
          final: true,
          toolChoice: SPEAK_ONLY,
          instruction:
            "Tell the caller warmly that this night is on the house, completely free, and that " +
            "you look forward to seeing them on the night they named earlier. Then say a friendly " +
            "goodbye. One or two short sentences - the call is ending.",
        },
      },
    },
    hungUp: {
      final: true,
      instruction:
        "The caller is gone. Do nothing further on this call - no more questions, no goodbye.",
    },
  },
} as const;

/**
 * The call's position, on its own slot. Persisted with the session, so a
 * reconnect resumes the script where it was rather than restarting it.
 */
export const deskFlow = dialog("desk", deskSpec);

/**
 * What `agent({ dialogs })` is handed — the line that wires
 * `@user-transcript.committed` and `@session.timed-out` to the dialog. Without
 * it the script could never advance from one turn to the next.
 */
export const DIALOGS: readonly AnyDialog[] = [deskFlow];
