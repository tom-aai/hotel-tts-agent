/**
 * The slim view types the reused desk UI (`client.tsx`) renders.
 *
 * The simplified agent runs one fixed booking script and declares no `syncState`,
 * so there is no live desk projection any more — the old hotel domain that filled
 * this sidebar (bookings, verification, a ledger of tickets) is gone. But the
 * shipped `client.tsx` still imports these three names to build its empty,
 * pre-call fallback, and the study reuses that screen unchanged. So this is kept,
 * self-contained, as just enough shape for the UI to compile and render an empty
 * desk beside the call.
 */

/** The ledger kinds the sidebar knows how to label (`client.tsx`'s `KIND_LABELS`). */
export type TicketKind =
  | "followup"
  | "wakeup_call"
  | "do_not_disturb"
  | "waitlist"
  | "tour"
  | "spa"
  | "business_center"
  | "flowers"
  | "email"
  | "transfer"
  | "flight_reconfirmation"
  | "airport_car"
  | "emergency"
  | "guest_message"
  | "group_inquiry"
  | "walk";

/** What the desk sidebar renders — now always empty, since nothing writes to it. */
export interface DeskView {
  verified: { name: string; code: string; room: string; stay: string; status: string } | null;
  draft: {
    mode: "new" | "modify";
    stay: string | null;
    room: string | null;
    extras: string | null;
    guest: string | null;
    card: string | null;
    total: string | null;
  } | null;
  /** Newest first. */
  ledger: { code: string; kind: TicketKind; summary: string }[];
  inHouse: number;
  arrivingToday: number;
}

/** The desk with nothing in it — the only state the scripted agent ever has. */
export interface HotelState {
  ledger: { code: string; kind: TicketKind; summary: string }[];
}

export function emptyHotelState(): HotelState {
  return { ledger: [] };
}

/** Project the (empty) state to the view `client.tsx` renders. */
export function deskView(state: HotelState): DeskView {
  return {
    verified: null,
    draft: null,
    ledger: state.ledger,
    inHouse: 0,
    arrivingToday: 0,
  };
}
