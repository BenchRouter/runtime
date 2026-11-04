// SERVE-007: the ONE bounded incremental SSE decoder.
//
// A network chunk is NEVER an SSE event. This decoder keeps a partial UTF-8 code
// point and a partial line across chunk boundaries, joins multiple `data:` lines
// of one event with a newline per the SSE standard, and emits complete events
// only. Every limit is measured in DECODED bytes, so a valid event can never
// depend on where the upstream happened to split its writes.
//
// Backpressure lives with the caller: `push` decodes only until the FIFO is
// full and RETAINS the rest of the already-read bytes, so nothing here becomes a
// background pump. Both the FIFO and the retained bytes count against the
// aggregate buffer bound.
//
// Upstream comments and metadata fields are dropped, never forwarded. An
// OpenRouter processing comment must not reach a customer.

import {
  MAX_PENDING_SSE_EVENTS,
  MAX_SSE_EVENT_BYTES,
  MAX_SSE_LINE_BYTES,
  MAX_STREAM_BUFFER_BYTES
} from "../constants";

/** Stable decode failure codes. Each reason is distinguishable in evidence. */
export type SseDecodeErrorCode =
  | "sse_invalid_utf8"
  | "sse_line_too_large"
  | "sse_event_too_large"
  | "sse_buffer_exhausted"
  | "sse_event_name_nul";

export class SseDecodeError extends Error {
  readonly code: SseDecodeErrorCode;

  constructor(code: SseDecodeErrorCode, message: string) {
    super(message);
    this.name = "SseDecodeError";
    this.code = code;
  }
}

export interface SseEvent {
  /** The `event:` field value, or null when the frame carried none. */
  event: string | null;
  /** The joined `data:` lines. */
  data: string;
  /** Decoded byte size of this event, for the aggregate buffer bound. */
  byteLength: number;
}

export interface SseDecoder {
  /** Feed one network chunk. Throws SseDecodeError on any bound or UTF-8 failure. */
  push(chunk: Uint8Array): void;
  /** Take the next complete event, or null when none is decoded yet. */
  drainOne(): SseEvent | null;
  /**
   * Close the input at upstream EOF: flush the streaming UTF-8 decoder (an
   * incomplete trailing code point is invalid UTF-8, never silently dropped) and
   * turn a trailing event that had no terminating blank line into an event.
   * Complete events stay in the FIFO, so the caller keeps draining with
   * `drainOne` until it returns null.
   */
  finish(): void;
  /** Decoded bytes currently held: FIFO events, the open event, and the retained tail. */
  readonly pendingBytes: number;
}

const UTF8_BOM = "\uFEFF";
const NUL = "\u0000";
const TEXT_ENCODER = new TextEncoder();

function utf8Length(value: string): number {
  return TEXT_ENCODER.encode(value).length;
}

interface OpenEvent {
  event: string | null;
  dataLines: string[];
  dataBytes: number;
  /** True once any field or comment line was seen, so a lone blank line is not an event. */
  started: boolean;
}

export function createSseDecoder(): SseDecoder {
  // A streaming decoder carries AT MOST one incomplete code point between
  // chunks; `fatal` turns invalid UTF-8 into a thrown error rather than a
  // silent replacement character.
  // `ignoreBOM: true` leaves the BOM in the decoded text so the strip below can
  // enforce "exactly one, only at stream start" rather than silently swallowing
  // a BOM that appears mid-stream.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let sawFirstChunk = false;
  /** True once `finish` ran: the input is closed and never decodes again. */
  let closed = false;
  /** True once the unterminated trailing line at EOF has been consumed. */
  let tailConsumed = false;
  /** Decoded characters read from the network but not yet split into lines. */
  let retained = "";
  let retainedBytes = 0;
  /** A CR ended the retained buffer: a following LF is the same line break. */
  let pendingCrLf = false;
  const fifo: SseEvent[] = [];
  let fifoBytes = 0;
  let open: OpenEvent = emptyOpenEvent();

  function emptyOpenEvent(): OpenEvent {
    return { event: null, dataLines: [], dataBytes: 0, started: false };
  }

  function totalBytes(): number {
    return fifoBytes + retainedBytes + open.dataBytes;
  }

  function assertBufferBound(): void {
    if (totalBytes() > MAX_STREAM_BUFFER_BYTES) {
      throw new SseDecodeError(
        "sse_buffer_exhausted",
        "The upstream stream exceeded the decoder's aggregate buffer bound."
      );
    }
  }

  function setRetained(value: string): void {
    retained = value;
    retainedBytes = utf8Length(value);
  }

  function finishEvent(): void {
    if (!open.started) {
      // A blank line with nothing before it is a no-op separator, not an event.
      return;
    }
    const current = open;
    open = emptyOpenEvent();
    if (current.dataLines.length === 0) {
      // Comment-only and metadata-only frames are DROPPED here: `id`, `retry`
      // and `:` comments are upstream transport detail, and an OpenRouter
      // processing comment must never reach a customer.
      return;
    }
    const event: SseEvent = {
      event: current.event,
      data: current.dataLines.join("\n"),
      byteLength: current.dataBytes
    };
    fifo.push(event);
    fifoBytes += event.byteLength;
    assertBufferBound();
  }

  function consumeLine(line: string): void {
    if (utf8Length(line) > MAX_SSE_LINE_BYTES) {
      throw new SseDecodeError("sse_line_too_large", "An upstream SSE line exceeded the line bound.");
    }
    if (line.length === 0) {
      finishEvent();
      return;
    }
    if (line.startsWith(":")) {
      // A comment. It proves liveness (the caller resets its idle timer on any
      // upstream byte) but carries nothing forwardable.
      open.started = true;
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // Exactly one optional leading space after the colon, per the SSE standard.
    if (value.startsWith(" ")) value = value.slice(1);

    open.started = true;
    switch (field) {
      case "event": {
        if (value.includes(NUL)) {
          throw new SseDecodeError("sse_event_name_nul", "An upstream SSE event name contained NUL.");
        }
        open.event = value;
        return;
      }
      case "data": {
        // Multiple `data:` lines of one event join with a newline. The join
        // separator counts toward the event bound because it is part of the
        // decoded payload.
        const added = utf8Length(value) + (open.dataLines.length === 0 ? 0 : 1);
        if (open.dataBytes + added > MAX_SSE_EVENT_BYTES) {
          throw new SseDecodeError("sse_event_too_large", "An upstream SSE event exceeded the event bound.");
        }
        open.dataLines.push(value);
        open.dataBytes += added;
        assertBufferBound();
        return;
      }
      default:
        // `id`, `retry`, and any unknown field are upstream metadata. Dropped.
        return;
    }
  }

  /** Index of the next LF or CR at or after `from`, or -1. */
  function nextBreak(from: number): number {
    for (let cursor = from; cursor < retained.length; cursor += 1) {
      const char = retained[cursor];
      if (char === "\n" || char === "\r") return cursor;
    }
    return -1;
  }

  /**
   * Split the retained buffer into lines and consume them until the FIFO holds
   * `fifoCeiling` events. Whatever is left stays retained, so a later drain
   * continues from the same bytes instead of reading upstream again.
   */
  function splitRetainedLines(fifoCeiling: number): void {
    let index = 0;
    while (fifo.length < fifoCeiling) {
      if (pendingCrLf) {
        if (index >= retained.length) break;
        // The LF half of a CRLF whose CR ended an earlier chunk.
        if (retained[index] === "\n") index += 1;
        pendingCrLf = false;
        continue;
      }
      const breakAt = nextBreak(index);
      if (breakAt === -1) {
        // No line terminator yet. The line bound is a DECODED-byte bound, so it
        // must be enforced on the open line too — otherwise an upstream that
        // never sends a break rides all the way to the aggregate bound before it
        // is refused, and the failure names the wrong reason.
        if (utf8Length(retained.slice(index)) > MAX_SSE_LINE_BYTES) {
          throw new SseDecodeError("sse_line_too_large", "An upstream SSE line exceeded the line bound.");
        }
        break;
      }
      const line = retained.slice(index, breakAt);
      if (retained[breakAt] === "\r") {
        // CR alone terminates the line. If the LF has not arrived yet, remember
        // that the next LF belongs to this same break.
        if (breakAt + 1 < retained.length) {
          index = retained[breakAt + 1] === "\n" ? breakAt + 2 : breakAt + 1;
        } else {
          index = breakAt + 1;
          pendingCrLf = true;
        }
      } else {
        index = breakAt + 1;
      }
      consumeLine(line);
    }
    if (index > 0) {
      setRetained(retained.slice(index));
      assertBufferBound();
    }
  }

  /**
   * At EOF, once every line-terminated event has been split, whatever is left is
   * a trailing line with no terminator. It is still an event, and so is an open
   * event with no terminating blank line. Runs exactly once.
   */
  function consumeTailAtEof(): void {
    if (!closed || tailConsumed) return;
    if (fifo.length >= MAX_PENDING_SSE_EVENTS) return;
    if (retained.length > 0) {
      // A line break still in the retained buffer means complete lines remain;
      // `splitRetainedLines` owns those and this tail is not reached yet.
      if (nextBreak(0) !== -1) return;
      const tail = retained;
      setRetained("");
      consumeLine(tail);
    }
    tailConsumed = true;
    finishEvent();
  }

  return {
    push(chunk: Uint8Array): void {
      let decoded: string;
      try {
        decoded = decoder.decode(chunk, { stream: true });
      } catch {
        throw new SseDecodeError("sse_invalid_utf8", "The upstream stream was not valid UTF-8.");
      }
      if (!sawFirstChunk && decoded.length > 0) {
        sawFirstChunk = true;
        // Exactly one BOM, only at stream start.
        if (decoded.startsWith(UTF8_BOM)) decoded = decoded.slice(1);
      }
      if (decoded.length === 0) return;
      setRetained(retained + decoded);
      assertBufferBound();
      splitRetainedLines(MAX_PENDING_SSE_EVENTS);
    },

    drainOne(): SseEvent | null {
      // Refill from the RETAINED bytes only. This never reads upstream, so it is
      // not a background pump.
      splitRetainedLines(MAX_PENDING_SSE_EVENTS);
      consumeTailAtEof();
      const event = fifo.shift();
      if (event === undefined) return null;
      fifoBytes -= event.byteLength;
      splitRetainedLines(MAX_PENDING_SSE_EVENTS);
      consumeTailAtEof();
      return event;
    },

    finish(): void {
      if (closed) return;
      closed = true;
      let trailing: string;
      try {
        // No `{ stream: true }`: a code point the upstream never finished is
        // INVALID UTF-8 at EOF, not a byte to discard.
        trailing = decoder.decode();
      } catch {
        throw new SseDecodeError("sse_invalid_utf8", "The upstream stream ended mid code point.");
      }
      if (trailing.length > 0) {
        setRetained(retained + trailing);
        assertBufferBound();
      }
      // The FIFO ceiling still applies at EOF. `drainOne` keeps splitting the
      // retained bytes as it consumes events, so a final chunk holding many
      // events is delivered progressively instead of filling an unbounded queue.
      splitRetainedLines(MAX_PENDING_SSE_EVENTS);
      consumeTailAtEof();
    },

    get pendingBytes(): number {
      return totalBytes();
    }
  };
}
