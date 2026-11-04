// SERVE-009: capture of a streamed call. The sidecar relays the SSE bytes to the app
// unchanged and feeds the same bytes to this assembler, which rebuilds the response
// body a non-streamed call would have returned. The case then records exactly like a
// non-streamed one. The SSE framing is the Worker's own bounded decoder
// (src/proxy/stream/sse.ts, listed in runtime/MIRROR.txt).
//
// The assembler never guesses. A stream that ends without its protocol terminal, carries
// an in-band error, fails a Responses create, or sends an event it does not know gives a
// reason instead of a body, and the call is not recorded.
import { createSseDecoder, SseDecodeError, type SseDecoder } from "../../src/proxy/stream/sse";
import { isJsonFiniteNumber, isJsonObject, isJsonString, type JsonObject, type JsonValue } from "./json";
import { parseJsonValueFromString } from "../../src/shared/json-parse-contracts";

export type AssembledStream = { ok: true; response: JsonObject } | { ok: false; reason: string };

export interface StreamAssembler {
  /** Feed one network chunk, exactly as relayed to the app. */
  push(chunk: Uint8Array): void;
  /** Close the input at upstream EOF and take the assembled response or the reason. */
  finish(): AssembledStream;
}

type Protocol = "chat" | "messages" | "responses";

interface ProtocolAssembler {
  /** One decoded event. Returns a failure reason, or null to continue. */
  step(event: string | null, data: string): string | null;
  /** The assembled body at EOF, or the reason there is none. */
  result(): AssembledStream;
}

function protocolOf(endpoint: string): Protocol | null {
  const pathname = endpoint.split("?")[0];
  if (pathname === "/v1/chat/completions") return "chat";
  if (pathname === "/v1/messages") return "messages";
  if (pathname === "/v1/responses") return "responses";
  return null;
}

/** A stream index field (choice, tool call, content block, output item), or null. */
function indexOf(value: JsonValue | undefined): number | null {
  return value !== undefined && isJsonFiniteNumber(value) ? value : null;
}

function parseObject(data: string): JsonObject | null {
  const parsed = parseJsonValueFromString(data);
  return parsed.ok && isJsonObject(parsed.value) ? parsed.value : null;
}

/** Text fields a Chat delta streams in pieces. Every other delta field is set, not joined. */
const CHAT_TEXT_FIELDS = new Set(["content", "refusal", "reasoning", "reasoning_content"]);

/** Fields of one OpenRouter `reasoning_details` entry that stream in pieces. */
const REASONING_TEXT_FIELDS = new Set(["text", "summary", "data"]);

/**
 * OpenRouter streams `reasoning_details` as fragments of entries. A fragment joins the
 * entry with its `index`, else the entry with its `type` and `id`, else starts a new one.
 * A fragment whose `type` or `id` differs from that entry's starts a new entry: a stream
 * can send summary fragments and then a separate encrypted entry all at index 0, where the
 * buffered response gives them distinct indices (OpenRouterTeam/ai-sdk-provider#519).
 * Text, summary and encrypted data join in order; a late field such as `signature` fills
 * the entry when it arrives. Entries keep the order they first appeared in.
 */
/** Both values are present strings and they are not the same: a new reasoning entry. */
function differs(current: JsonValue | undefined, next: JsonValue | undefined): boolean {
  return current !== undefined && next !== undefined && isJsonString(current) && isJsonString(next) && current !== next;
}

interface ReasoningDetails {
  merge: (fragment: JsonObject) => void;
  entries: () => JsonObject[];
}

function reasoningDetails(): ReasoningDetails {
  const ordered: JsonObject[] = [];
  const keyed = new Map<string, JsonObject>();
  return {
    merge(fragment) {
      const index = indexOf(fragment.index);
      const key = index !== null
        ? `index:${index}`
        : isJsonString(fragment.id) && isJsonString(fragment.type) ? `id:${fragment.type}:${fragment.id}` : null;
      let entry = key === null ? undefined : keyed.get(key);
      if (entry !== undefined && (differs(entry.type, fragment.type) || differs(entry.id, fragment.id))) entry = undefined;
      if (entry === undefined) {
        entry = {};
        ordered.push(entry);
        if (key !== null) keyed.set(key, entry);
      }
      for (const [field, piece] of Object.entries(fragment)) {
        if (piece === undefined || piece === null) continue;
        const prior = entry[field];
        if (REASONING_TEXT_FIELDS.has(field) && isJsonString(piece) && isJsonString(prior)) entry[field] = prior + piece;
        else if (prior === undefined || prior === null || prior === "") entry[field] = piece;
      }
    },
    entries: () => ordered
  };
}

function chatAssembler(): ProtocolAssembler {
  let envelope: JsonObject | null = null;
  let usage: JsonValue | undefined;
  let done = false;
  const choices = new Map<number, {
    message: JsonObject;
    toolCalls: Map<number, JsonObject>;
    reasoning: ReasoningDetails | null;
    finishReason: JsonValue;
  }>();

  function mergeToolCall(calls: Map<number, JsonObject>, fragment: JsonObject): void {
    const index = indexOf(fragment.index) ?? calls.size;
    const call = calls.get(index) ?? {};
    for (const [key, value] of Object.entries(fragment)) {
      if (key === "index" || value === undefined || value === null) continue;
      if (key === "function" && isJsonObject(value)) {
        const target = call.function !== undefined && isJsonObject(call.function) ? call.function : {};
        for (const [field, piece] of Object.entries(value)) {
          if (piece === undefined || piece === null) continue;
          // `arguments` streams in pieces. `name` arrives once; a repeat is not appended.
          const prior = target[field];
          target[field] = field === "arguments" && isJsonString(piece) && isJsonString(prior) ? prior + piece : prior ?? piece;
        }
        call.function = target;
      } else if (call[key] === undefined) {
        call[key] = value;
      }
    }
    calls.set(index, call);
  }

  return {
    step(_event, data) {
      if (data === "[DONE]") {
        done = true;
        return null;
      }
      const chunk = parseObject(data);
      if (chunk === null) return "stream_malformed_event";
      // The Worker's in-band error frame (shared/http.ts chatInBandStreamError).
      if (chunk.error !== undefined) return "upstream_stream_error";
      if (envelope === null) envelope = { id: chunk.id ?? null, created: chunk.created ?? null, model: chunk.model ?? null };
      if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
      for (const raw of Array.isArray(chunk.choices) ? chunk.choices : []) {
        if (!isJsonObject(raw)) return "stream_malformed_event";
        const index = indexOf(raw.index) ?? 0;
        const choice = choices.get(index) ?? { message: {}, toolCalls: new Map<number, JsonObject>(), reasoning: null, finishReason: null };
        choices.set(index, choice);
        const delta = raw.delta !== undefined && isJsonObject(raw.delta) ? raw.delta : {};
        for (const [key, value] of Object.entries(delta)) {
          if (value === undefined) continue;
          if (key === "tool_calls") {
            if (!Array.isArray(value)) return "stream_malformed_event";
            for (const fragment of value) {
              if (!isJsonObject(fragment)) return "stream_malformed_event";
              mergeToolCall(choice.toolCalls, fragment);
            }
            continue;
          }
          if (key === "reasoning_details") {
            if (!Array.isArray(value)) return "stream_malformed_event";
            choice.reasoning ??= reasoningDetails();
            for (const fragment of value) {
              if (!isJsonObject(fragment)) return "stream_malformed_event";
              choice.reasoning.merge(fragment);
            }
            continue;
          }
          const prior = choice.message[key];
          if (CHAT_TEXT_FIELDS.has(key) && isJsonString(value) && isJsonString(prior)) choice.message[key] = prior + value;
          else if (prior === undefined || prior === null) choice.message[key] = value;
        }
        if (raw.finish_reason !== undefined && raw.finish_reason !== null) choice.finishReason = raw.finish_reason;
      }
      return null;
    },
    result() {
      // The Worker ends a failed Chat stream WITHOUT `[DONE]`.
      if (!done || envelope === null) return { ok: false, reason: "stream_incomplete" };
      const assembled = [...choices.entries()].sort(([a], [b]) => a - b).map(([index, choice]) => {
        const message: JsonObject = { role: "assistant", content: null, ...choice.message };
        if (choice.reasoning !== null) message.reasoning_details = choice.reasoning.entries();
        if (choice.toolCalls.size > 0) message.tool_calls = [...choice.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
        return { index, message, finish_reason: choice.finishReason };
      });
      const response: JsonObject = { ...envelope, object: "chat.completion", choices: assembled };
      if (usage !== undefined) response.usage = usage;
      return { ok: true, response };
    }
  };
}

function messagesAssembler(): ProtocolAssembler {
  let message: JsonObject | null = null;
  let stopped = false;
  const blocks = new Map<number, JsonObject>();
  const partialJson = new Map<number, string>();

  function appendText(block: JsonObject, field: string, piece: JsonValue | undefined): string | null {
    if (!isJsonString(piece)) return "stream_malformed_event";
    const prior = block[field];
    block[field] = (isJsonString(prior) ? prior : "") + piece;
    return null;
  }

  return {
    step(event, data) {
      const payload = parseObject(data);
      if (payload === null) return "stream_malformed_event";
      const type = isJsonString(payload.type) ? payload.type : event;
      switch (type) {
        case "ping":
          return null;
        case "error":
          // The Worker's in-band `error` event (shared/http.ts messagesInBandStreamError).
          return "upstream_stream_error";
        case "message_start": {
          if (payload.message === undefined || !isJsonObject(payload.message)) return "stream_malformed_event";
          message = { ...payload.message };
          return null;
        }
        case "content_block_start": {
          const index = indexOf(payload.index);
          if (index === null || payload.content_block === undefined || !isJsonObject(payload.content_block)) return "stream_malformed_event";
          blocks.set(index, { ...payload.content_block });
          return null;
        }
        case "content_block_delta": {
          const index = indexOf(payload.index);
          const block = index === null ? undefined : blocks.get(index);
          const delta = payload.delta;
          if (index === null || block === undefined || delta === undefined || !isJsonObject(delta)) return "stream_malformed_event";
          if (delta.type === "text_delta") return appendText(block, "text", delta.text);
          if (delta.type === "thinking_delta") return appendText(block, "thinking", delta.thinking);
          if (delta.type === "signature_delta") return appendText(block, "signature", delta.signature);
          if (delta.type === "input_json_delta") {
            if (!isJsonString(delta.partial_json)) return "stream_malformed_event";
            partialJson.set(index, (partialJson.get(index) ?? "") + delta.partial_json);
            return null;
          }
          if (delta.type === "citations_delta") {
            const citations = Array.isArray(block.citations) ? block.citations : [];
            if (delta.citation !== undefined) citations.push(delta.citation);
            block.citations = citations;
            return null;
          }
          return "stream_unsupported_event";
        }
        case "content_block_stop": {
          const index = indexOf(payload.index) ?? -1;
          const block = blocks.get(index);
          if (block === undefined) return "stream_malformed_event";
          const json = partialJson.get(index);
          // A tool_use block's input arrives as JSON text; an empty text keeps the start input.
          if (json !== undefined && json.length > 0) {
            const input = parseJsonValueFromString(json);
            if (!input.ok) return "stream_malformed_tool_input";
            block.input = input.value;
          }
          return null;
        }
        case "message_delta": {
          if (message === null) return "stream_malformed_event";
          const delta = payload.delta !== undefined && isJsonObject(payload.delta) ? payload.delta : {};
          for (const [key, value] of Object.entries(delta)) {
            if (value !== undefined) message[key] = value;
          }
          if (payload.usage !== undefined && isJsonObject(payload.usage)) {
            const prior = message.usage !== undefined && isJsonObject(message.usage) ? message.usage : {};
            message.usage = { ...prior, ...payload.usage };
          }
          return null;
        }
        case "message_stop":
          stopped = true;
          return null;
        default:
          return "stream_unsupported_event";
      }
    },
    result() {
      // The Worker ends a failed Messages stream WITHOUT `message_stop`.
      if (!stopped || message === null) return { ok: false, reason: "stream_incomplete" };
      const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
      return { ok: true, response: { ...message, content } };
    }
  };
}

function responsesAssembler(): ProtocolAssembler {
  let terminal: JsonObject | null = null;
  const items = new Map<number, JsonValue>();

  return {
    step(event, data) {
      if (data === "[DONE]") return null;
      const payload = parseObject(data);
      if (payload === null) return "stream_malformed_event";
      const type = isJsonString(payload.type) ? payload.type : event;
      if (type === "error" || type === "response.failed") return "upstream_stream_error";
      if (type === "response.output_item.done") {
        const index = indexOf(payload.output_index);
        if (index === null || payload.item === undefined) return "stream_malformed_event";
        items.set(index, payload.item);
        return null;
      }
      if (type === "response.completed" || type === "response.incomplete") {
        if (payload.response === undefined || !isJsonObject(payload.response)) return "stream_malformed_event";
        terminal = payload.response;
      }
      // Every other event is a delta of an item that its `output_item.done` repeats whole.
      return null;
    },
    result() {
      if (terminal === null) return { ok: false, reason: "stream_incomplete" };
      // The terminal response carries the ordered output. A terminal without it takes the done items.
      const output = Array.isArray(terminal.output) && terminal.output.length > 0
        ? terminal.output
        : [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      return { ok: true, response: { ...terminal, output } };
    }
  };
}

export function createStreamAssembler(endpoint: string): StreamAssembler {
  const protocol = protocolOf(endpoint);
  const assembler = protocol === "chat" ? chatAssembler() : protocol === "messages" ? messagesAssembler() : protocol === "responses" ? responsesAssembler() : null;
  const decoder: SseDecoder = createSseDecoder();
  let failure: string | null = assembler === null ? "stream_endpoint_unsupported" : null;

  function drain(): void {
    if (assembler === null) return;
    for (let event = decoder.drainOne(); event !== null && failure === null; event = decoder.drainOne()) {
      failure = assembler.step(event.event, event.data);
    }
  }

  function guarded(action: () => void): void {
    if (failure !== null) return;
    try {
      action();
      drain();
    } catch (error) {
      failure = error instanceof SseDecodeError ? error.code : "stream_malformed_event";
    }
  }

  return {
    push(chunk) {
      guarded(() => decoder.push(chunk));
    },
    finish() {
      guarded(() => decoder.finish());
      if (failure !== null || assembler === null) return { ok: false, reason: failure ?? "stream_endpoint_unsupported" };
      return assembler.result();
    }
  };
}
