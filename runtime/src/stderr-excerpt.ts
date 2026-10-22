// RUN-001 §3.11 / DATA-001: the evaluator's error, shown in the customer's own GitHub.
// The runtime keeps a bounded copy of the evaluator's stderr while it forwards every
// chunk to the job log unchanged. On an evaluator failure it builds a local excerpt:
// the error line and a short tail, with every secret the evaluator received and every
// word with a known secret prefix redacted. The excerpt goes only to the job summary
// and the job's annotations. It is never sent to BenchRouter: it is not in any request
// body, and not in `diagnostics`.
import { looksLikeSecret, REDACTED, SECRET_PREFIXES } from "./capture";

/** The first bytes of stderr kept; the error line of a crash at import is near the start. */
const HEAD_BYTES = 64 * 1024;
/** The last bytes of stderr kept; the tail of the excerpt comes from here. */
const TAIL_BYTES = 16 * 1024;
const TAIL_LINES = 30;
const TAIL_CHARS = 3 * 1024;
const ERROR_LINE_CHARS = 500;
/** Characters that end a piece of a word, so a quoted or assigned secret is still found. */
const PIECE_DELIMITERS = new Set(["\"", "'", "`", "(", ")", "[", "]", "{", "}", "<", ">", ",", ";", "=", ":"]);

/** The scrubbed excerpt of a failed evaluator run. */
export interface EvaluatorErrorExcerpt {
  /** The first line that names an error class, or the last non-empty line; null when stderr was empty. */
  errorLine: string | null;
  /** At most 30 lines and about 3 KB of the end of stderr; empty when stderr was empty. */
  tail: string;
  /** How the evaluator ended, such as "exited with code 1". */
  ending: string;
}

/** A bounded copy of a stream: the first 64 KiB and the last 16 KiB. */
export class BoundedCapture {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headBytes < HEAD_BYTES) {
      const part = chunk.subarray(0, HEAD_BYTES - this.headBytes);
      this.head.push(part);
      this.headBytes += part.length;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tail.length > 1 && this.tailBytes - (this.tail[0]?.length ?? 0) >= TAIL_BYTES) {
      this.tailBytes -= this.tail[0]?.length ?? 0;
      this.tail.shift();
    }
  }

  /**
   * The kept text as lines. When the stream was longer than both parts together, the
   * head drops its last partial line and the tail its first one, so a secret is never
   * kept cut in two, where the exact-value scrub could not find it.
   */
  lines(): StderrLines {
    const tailBuffer = Buffer.concat(this.tail);
    // The tail holds at least the last min(total, TAIL_BYTES) bytes, so up to HEAD_BYTES +
    // TAIL_BYTES the head and the rest of the tail are the whole stream.
    if (this.total <= HEAD_BYTES + TAIL_BYTES) {
      const rest = tailBuffer.subarray(tailBuffer.length - Math.max(0, this.total - HEAD_BYTES));
      return { head: splitLines(Buffer.concat([...this.head, rest]).toString("utf8")), tail: [] };
    }
    const head = splitLines(Buffer.concat(this.head).toString("utf8"));
    head.pop();
    const tail = splitLines(tailBuffer.subarray(tailBuffer.length - TAIL_BYTES).toString("utf8"));
    tail.shift();
    return { head, tail };
  }
}

/** The kept head and tail of a stream, as lines. */
export interface StderrLines {
  head: string[];
  tail: string[];
}

function splitLines(text: string): string[] {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\f" || char === "\v";
}

/** The pieces of a word between delimiter characters. */
function pieces(word: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of word) {
    if (PIECE_DELIMITERS.has(char)) {
      if (current.length > 0) out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** The prefixes that span two words, such as `Bearer `. */
const TWO_WORD_PREFIXES = SECRET_PREFIXES.filter((prefix) => prefix.includes(" "));

/** A word with a piece that starts with a secret prefix, or the word after the first part of a two-word prefix (`Bearer <token>`). */
function wordIsSecret(word: string, previousWord: string | null): boolean {
  const own = pieces(word);
  if (own.some(looksLikeSecret)) return true;
  const before = previousWord === null ? undefined : pieces(previousWord).pop();
  const first = own[0];
  if (before === undefined || first === undefined) return false;
  const joined = `${before} ${first}`;
  return TWO_WORD_PREFIXES.some((prefix) => prefix.startsWith(`${before} `)) && looksLikeSecret(joined);
}

/** Redact every whitespace-delimited word that looks like a secret; whitespace stays as it was. */
function redactSecretWords(line: string): string {
  let out = "";
  let word = "";
  let previous: string | null = null;
  const flush = () => {
    if (word.length === 0) return;
    out += wordIsSecret(word, previous) ? REDACTED : word;
    previous = word;
    word = "";
  };
  for (const char of line) {
    if (isSpace(char)) {
      flush();
      out += char;
    } else {
      word += char;
    }
  }
  flush();
  return out;
}

/** Replace every exact occurrence of each secret value, longest first, then redact secret-looking words. */
export function scrubLine(line: string, secrets: readonly string[]): string {
  let text = line;
  for (const secret of [...secrets].filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join(REDACTED);
  }
  return redactSecretWords(text);
}

/** `Error: …`, `TypeError: …`, `Error [ERR_X]: …`, `ModuleNotFoundError: …`: one word ending in Error or Exception before the first ": ". */
function namesError(line: string): boolean {
  const text = line.trimStart();
  const colon = text.indexOf(": ");
  if (colon <= 0) return false;
  let head = text.slice(0, colon);
  // Node adds the error code after the class name: `Error [ERR_MODULE_NOT_FOUND]: …`.
  const code = head.indexOf(" [");
  if (code > 0 && head.endsWith("]")) head = head.slice(0, code);
  for (const char of head) if (isSpace(char)) return false;
  return head.endsWith("Error") || head.endsWith("Exception");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The excerpt of the captured stderr, scrubbed before it is searched or cut. */
export function buildExcerpt(capture: BoundedCapture, secrets: readonly string[], ending: string): EvaluatorErrorExcerpt {
  const kept = capture.lines();
  const head = kept.head.map((line) => scrubLine(line, secrets));
  const tail = kept.tail.map((line) => scrubLine(line, secrets));
  const nonEmpty = [...head, ...tail].filter((line) => line.trim().length > 0);
  const named = nonEmpty.find(namesError) ?? nonEmpty[nonEmpty.length - 1] ?? null;
  const source = tail.length > 0 ? tail : head;
  let end = source.length;
  while (end > 0 && (source[end - 1] ?? "").trim().length === 0) end -= 1;
  const picked: string[] = [];
  let chars = 0;
  for (let index = end - 1; index >= 0 && picked.length < TAIL_LINES; index -= 1) {
    const line = source[index] ?? "";
    if (chars + line.length + 1 > TAIL_CHARS) {
      if (picked.length === 0) picked.unshift(line.slice(line.length - TAIL_CHARS));
      break;
    }
    picked.unshift(line);
    chars += line.length + 1;
  }
  return { errorLine: named === null ? null : clip(named.trim(), ERROR_LINE_CHARS), tail: picked.join("\n"), ending };
}
