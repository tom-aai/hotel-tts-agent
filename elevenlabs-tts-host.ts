import { registerTtsKind } from "@alexkroman1/aai-runtime";
import type {
  TtsError,
  TtsEvents,
  TtsOpener,
  TtsOpenOptions,
  TtsSession,
  Unsubscribe,
} from "@alexkroman1/aai-runtime";
import { createTtsError } from "@alexkroman1/aai/host-internal";
import { randomUUID } from "node:crypto";
import {
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_TTS_KIND,
  resolveElevenLabsTtsSettings,
  type ElevenLabsTtsOptions,
} from "./elevenlabs-tts.ts";

/**
 * ElevenLabs TTS — the HOST half (Phase 3, the one provider we build).
 *
 * The descriptor half (`elevenlabs-tts.ts`) is pure data; this is the part that
 * does the work: it opens ElevenLabs' multi-context streaming WebSocket when a
 * call starts, feeds it the model's words, and emits the sound back on the same
 * {@link TtsEvents} contract the pipeline consumes from every provider. Register
 * it once with {@link registerElevenLabsTts} in the HOST process (the server,
 * Phases 4/8; `elevenlabs-smoke.ts` for a standalone proof) and an `elevenlabs`
 * row then resolves and speaks like any AssemblyAI or Cartesia row.
 *
 * It is modelled on the toolkit's own Cartesia opener: one socket per session,
 * one ElevenLabs *context* per turn, and a fresh context minted after each
 * `flush()`/`cancel()` so a barge-in only ever cancels the in-flight turn. Each
 * turn's context is explicitly closed (flush, then close) rather than left
 * dangling — ElevenLabs caps a socket at a handful of live contexts and drops it
 * with a 1008 once that is exceeded.
 *
 * Two shapes to know about ElevenLabs' wire, both confirmed against the API
 * reference: the client speaks snake_case (`context_id`, `close_context`,
 * `xi_api_key`) and the server answers camelCase (`contextId`, `isFinal`); and
 * the key travels in the first message per context, because the browser-style
 * global `WebSocket` (Node 24's built-in, used here to add no dependency) cannot
 * set the `xi-api-key` header a raw socket would.
 */

/** Output sample rates ElevenLabs can emit as raw PCM16 LE (`pcm_<rate>`). */
const ELEVENLABS_PCM_RATES = [8000, 16000, 22050, 24000, 44100];

/** How long to wait for the socket to open before giving up. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Fallbacks for the turn-end `done` the pipeline waits on. The server sends
 * `isFinal` for a flushed context, and that is the normal path; these cover the
 * case where it does not arrive. {@link FIRST_AUDIO_TIMEOUT_MS} is the grace for
 * the first chunk after a flush (synthesis has to start), {@link QUIESCENCE_MS}
 * the gap after the last chunk that means the turn has drained.
 */
const FIRST_AUDIO_TIMEOUT_MS = 8_000;
const QUIESCENCE_MS = 400;

/** Decode one base64 PCM16-LE chunk into an `Int16Array`, endian-safe. */
function base64Pcm16ToInt16(b64: string): Int16Array {
  const bytes = Buffer.from(b64, "base64");
  const sampleCount = bytes.byteLength >> 1; // drop a stray odd byte
  const pcm = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) pcm[i] = bytes.readInt16LE(i << 1);
  return pcm;
}

/** A single-shot timer that can be re-armed or cleared — the quiescence clock. */
function createRestartableTimer(onFire: () => void) {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return {
    arm(ms: number) {
      if (handle !== undefined) clearTimeout(handle);
      handle = setTimeout(() => {
        handle = undefined;
        onFire();
      }, ms);
    },
    pending: () => handle !== undefined,
    clear() {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}

type AnyListener = (...args: never[]) => void;

/**
 * The session scaffolding every opener repeats, inlined so this connector leans
 * on no unpublished toolkit internal: a `closed` latch, an idempotent `close()`,
 * a typed emit/subscribe surface, and the rule that nothing fans out once the
 * session is closed and a listener's throw never escapes a socket handler.
 */
function createShell(teardown: () => void) {
  const listeners = new Map<keyof TtsEvents, Set<AnyListener>>();
  let closed = false;
  const contain = (fan: () => void) => {
    if (closed) return;
    try {
      fan();
    } catch {
      // A caller-supplied listener's throw must not escape the raw socket
      // handler that fired the event (an uncaughtException on a shared host).
    }
  };
  const emit = <E extends keyof TtsEvents>(event: E, ...args: Parameters<TtsEvents[E]>) =>
    contain(() => {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of [...set]) (fn as (...a: Parameters<TtsEvents[E]>) => void)(...args);
    });
  const on = <E extends keyof TtsEvents>(event: E, fn: TtsEvents[E]): Unsubscribe => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(fn as AnyListener);
    return () => {
      set.delete(fn as AnyListener);
    };
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      teardown();
    } catch {
      // teardown is best-effort — the socket may already be gone.
    }
  };
  const streamError = (message: string) => emit("error", createTtsError("tts_stream_error", message));
  return { isClosed: () => closed, close, emit, on, streamError };
}

/**
 * The `done`-once-per-turn latch. The pipeline advances the turn on `done`, so a
 * duplicate — the server's `isFinal` racing the quiescence timer or a cancel —
 * would advance it mid-reply.
 */
function createDoneLatch(isClosed: () => boolean, emitDone: () => void) {
  let emitted = false;
  return {
    emitted: () => emitted,
    emitOnce() {
      if (emitted || isClosed()) return;
      emitted = true;
      emitDone();
    },
    rearm() {
      emitted = false;
    },
  };
}

/** The context id carried by a server frame, in either casing ElevenLabs uses. */
function frameContextId(msg: Record<string, unknown>): string | undefined {
  if (typeof msg.contextId === "string") return msg.contextId;
  if (typeof msg.context_id === "string") return msg.context_id;
  return undefined;
}

/** Resolve once the socket opens, or reject on error, abort, or timeout. */
function waitForOpen(ws: WebSocket, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fail = (err: TtsError) => {
      cleanup();
      try {
        ws.close();
      } catch {
        // already closing
      }
      reject(err);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () =>
      fail(createTtsError("tts_connect_failed", "ElevenLabs TTS: connect failed"));
    const onAbort = () =>
      fail(createTtsError("tts_connect_failed", "ElevenLabs TTS: aborted before connect"));
    const timer = setTimeout(
      () => fail(createTtsError("tts_connect_failed", "ElevenLabs TTS: connect timed out")),
      CONNECT_TIMEOUT_MS,
    );
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Build a {@link TtsOpener} from resolved ElevenLabs descriptor options. */
export function openElevenLabs(opts: ElevenLabsTtsOptions): TtsOpener {
  return {
    name: ELEVENLABS_TTS_KIND,
    async open(openOpts: TtsOpenOptions): Promise<TtsSession> {
      const { apiKey, sampleRate, signal } = openOpts;
      if (!apiKey) {
        throw createTtsError(
          "tts_auth_failed",
          `ElevenLabs TTS: missing API key. Set ${ELEVENLABS_API_KEY_ENV} in the agent env.`,
        );
      }
      if (!ELEVENLABS_PCM_RATES.includes(sampleRate)) {
        throw createTtsError(
          "tts_connect_failed",
          `ElevenLabs TTS: unsupported sample rate ${sampleRate}. ` +
            `Supported: ${ELEVENLABS_PCM_RATES.join(", ")}.`,
        );
      }
      const { voice, model, language } = resolveElevenLabsTtsSettings(opts);

      const params = new URLSearchParams({
        model_id: model,
        output_format: `pcm_${sampleRate}`,
        inactivity_timeout: "180",
      });
      if (language) params.set("language_code", language);
      const url =
        `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}` +
        `/multi-stream-input?${params.toString()}`;

      const ws = new WebSocket(url);
      await waitForOpen(ws, signal);

      let quiescence!: ReturnType<typeof createRestartableTimer>;
      const shell = createShell(() => {
        quiescence?.clear();
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ close_socket: true }));
        } catch {
          // best-effort — fall through to close()
        }
        try {
          ws.close(1000, "client close");
        } catch {
          // already closing
        }
      });
      const doneLatch = createDoneLatch(shell.isClosed, () => shell.emit("done"));
      const emitDoneOnce = () => {
        quiescence.clear();
        doneLatch.emitOnce();
      };
      quiescence = createRestartableTimer(emitDoneOnce);

      const safeSend = (payload: Record<string, unknown>) => {
        if (shell.isClosed() || ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify(payload));
        } catch (err) {
          shell.streamError(`ElevenLabs TTS: send failed: ${String(err)}`);
        }
      };

      /** A new context: a fresh id, (re)initialised with the key and a seed space. */
      const openContext = (contextId: string) =>
        safeSend({ text: " ", context_id: contextId, xi_api_key: apiKey });

      let context = randomUUID();
      let rotatePending = false;
      let activeContextCancelled = false;
      const rotateIfPending = () => {
        if (!rotatePending) return;
        context = randomUUID();
        openContext(context);
        doneLatch.rearm();
        rotatePending = false;
        activeContextCancelled = false;
      };

      ws.addEventListener("message", (event: MessageEvent) => {
        if (shell.isClosed()) return;
        if (typeof event.data !== "string") return; // ElevenLabs sends JSON text frames
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const forOtherContext = () => {
          const id = frameContextId(msg);
          return id !== undefined && id !== context;
        };
        if (typeof msg.audio === "string" && msg.audio.length > 0) {
          if (forOtherContext() || activeContextCancelled) return;
          const pcm = base64Pcm16ToInt16(msg.audio);
          if (pcm.length === 0) return;
          shell.emit("audio", pcm);
          if (quiescence.pending()) quiescence.arm(QUIESCENCE_MS);
          return;
        }
        if (msg.isFinal === true) {
          if (forOtherContext()) return;
          emitDoneOnce();
          return;
        }
        if (typeof msg.error === "string") shell.streamError(`ElevenLabs TTS: ${msg.error}`);
      });

      ws.addEventListener("error", () => {
        if (!shell.isClosed()) shell.streamError("ElevenLabs TTS: socket error");
      });
      ws.addEventListener("close", (event: CloseEvent) => {
        if (shell.isClosed()) return;
        emitDoneOnce();
        if (event.code !== 1000) shell.streamError(`ElevenLabs TTS: socket closed ${event.code}`);
      });

      const onAbort = () => void shell.close();
      if (signal.aborted) void shell.close();
      else signal.addEventListener("abort", onAbort, { once: true });

      // Open the first turn's context eagerly, as the Cartesia opener mints its.
      openContext(context);

      return {
        sendText(text: string) {
          if (shell.isClosed() || text.length === 0) return;
          rotateIfPending();
          safeSend({ text, context_id: context, flush: false });
        },
        flush() {
          if (shell.isClosed() || rotatePending) return;
          // Flush this turn's buffered text, then close its context so a long
          // call never outruns ElevenLabs' per-socket context cap. A close after
          // a flush finishes flushing first, so no audio is lost.
          safeSend({ context_id: context, flush: true });
          safeSend({ context_id: context, close_context: true });
          rotatePending = true;
          quiescence.arm(FIRST_AUDIO_TIMEOUT_MS);
        },
        cancel() {
          if (shell.isClosed()) return;
          if (!doneLatch.emitted()) safeSend({ context_id: context, close_context: true });
          activeContextCancelled = true;
          emitDoneOnce();
          rotatePending = true;
        },
        on: shell.on,
        close: shell.close,
      };
    },
  };
}

/**
 * Register the ElevenLabs TTS kind on the host's live provider registry, so an
 * `elevenlabs` descriptor from `voices.ts` resolves and speaks. Returns the
 * unregister function. Call it once in the HOST process before serving.
 */
export function registerElevenLabsTts(): () => void {
  return registerTtsKind(ELEVENLABS_TTS_KIND, {
    envVar: ELEVENLABS_API_KEY_ENV,
    open: (descriptor) => openElevenLabs(descriptor.options as ElevenLabsTtsOptions),
  });
}
