// RUN-001 §2.3: GitHub Actions `paths` filter matching. The server checks that
// every file a route declares is inside the committed trigger globs, so a change
// to that file always starts a run.
//
// Semantics (GitHub "Filter pattern cheat sheet"): patterns apply in order; a
// path is included by the last pattern that matches it, and a `!` pattern
// excludes. `*` matches any characters except `/`; `**` matches any characters,
// `/` included (so `**.ts` matches `src/a.ts`); `**/` also matches nothing (so
// `**/a.ts` matches `a.ts`); `?` matches one character except `/`. A pattern
// with `[` or `+` is not supported here and matches nothing, so the check
// fails closed.

type GlobToken = { kind: "any_dirs" } | { kind: "any" } | { kind: "segment_any" } | { kind: "one" } | { kind: "literal"; char: string };

function tokenize(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        tokens.push({ kind: "any_dirs" });
        index += 3;
      } else {
        tokens.push({ kind: "any" });
        index += 2;
      }
    } else if (char === "*") {
      tokens.push({ kind: "segment_any" });
      index += 1;
    } else if (char === "?") {
      tokens.push({ kind: "one" });
      index += 1;
    } else {
      tokens.push({ kind: "literal", char });
      index += 1;
    }
  }
  return tokens;
}

function tokensMatch(tokens: GlobToken[], path: string): boolean {
  // memo[t][p]: whether tokens[t..] match path[p..].
  const memo = new Map<number, boolean>();
  const width = path.length + 1;
  const match = (t: number, p: number): boolean => {
    const key = t * width + p;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    const token = tokens[t];
    if (token === undefined) {
      result = p === path.length;
    } else if (token.kind === "literal") {
      result = path[p] === token.char && match(t + 1, p + 1);
    } else if (token.kind === "one") {
      result = p < path.length && path[p] !== "/" && match(t + 1, p + 1);
    } else if (token.kind === "segment_any") {
      result = false;
      for (let end = p; end <= path.length; end += 1) {
        if (match(t + 1, end)) {
          result = true;
          break;
        }
        if (path[end] === "/") break;
      }
    } else if (token.kind === "any") {
      result = false;
      for (let end = p; end <= path.length; end += 1) {
        if (match(t + 1, end)) {
          result = true;
          break;
        }
      }
    } else {
      // `**/`: nothing, or any characters that end with `/`.
      result = match(t + 1, p);
      for (let end = p + 1; !result && end <= path.length; end += 1) {
        if (path[end - 1] === "/" && match(t + 1, end)) result = true;
      }
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

export function pathGlobMatches(pattern: string, path: string): boolean {
  if (pattern.length === 0 || pattern.includes("[") || pattern.includes("+")) return false;
  const normalized = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  return tokensMatch(tokenize(normalized), path);
}

/**
 * Whether a change to `path` triggers the workflow. An empty filter list means
 * the workflow has no `paths` filter, so every path triggers.
 */
export function pathTriggersWorkflow(patterns: readonly string[], path: string): boolean {
  if (patterns.length === 0) return true;
  let included = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (pathGlobMatches(pattern.slice(1), path)) included = false;
    } else if (pathGlobMatches(pattern, path)) {
      included = true;
    }
  }
  return included;
}

/** A normalized repository-relative path: no leading `/`, no `.`/`..`/empty segments, no backslash. */
export function isNormalizedRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || path.startsWith("~") || path[1] === ":") return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
