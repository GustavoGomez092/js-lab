import { redactRegistryUrl } from "./npmrc";

/*
 * R-M3-T26-FIX-3: the one credential masker, shared by Main (npm-spawn.ts masks every complete line per stream
 * before it leaves the process) and the UI (defense in depth). Node-free: it imports only `./npmrc`, which is
 * browser-safe. Every pattern is linear-time: bounded or single-class quantifiers, no nested quantifiers over the
 * same class (I-2). Masking is idempotent: `maskCredentials(maskCredentials(x)) === maskCredentials(x)`.
 */

// A URL-shaped substring up to whitespace or a quote (redactRegistryUrl parses a bare URL). The scheme is bounded
// at 32 characters: an unbounded scheme retried the whole run at every start inside a long token-like run (I-2).
const URL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s"']+/g;

// Fix round 3 (Nm-2): the userinfo fallback requires a scheme, so `node_modules//@types` and `host//@scope` are
// never touched. It catches a URL whose password stops URL_PATTERN short (a quote inside it), so the partial match
// never parsed and redactRegistryUrl returned it unchanged.
const USERINFO_FALLBACK_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/)[^@\s/]*@/g;
const MASKED_USERINFO = "***";

// Fix round 3 (N-c): `_authToken|_auth|_password` counts only as a whole key, preceded by start-of-text or a
// non-alphanumeric character (group 1, re-emitted), then an optional quote and spaces, then `:` or `=`. So
// `my_auth: enabled` stays, while `//r/:_authToken=x`, `"_authToken": "x"` and `_auth = x` are masked. Fix round 4
// (NI3-1): the boundary is any non-alphanumeric, not an allowlist, so `npm_config__authToken=x`, `config._auth=x` and
// `(_authToken=x)` are masked too. Fix round 4 (NM3-1): separators are spaces or tabs, never a line break, so a key
// is never joined to a value on the next line and masking is line-local. `_authToken` stays ahead of `_auth` so the
// longer key wins. A quoted value may contain spaces.
const AUTH_VALUE_PATTERN =
  /(^|[^A-Za-z0-9])(_authToken|_auth|_password)(["']?[ \t]*[:=][ \t]*)("[^"\n]*"|'[^'\n]*'|\S+)/gi;

// Fix round 3 (N-c): an Authorization (or Proxy-Authorization) header only with Bearer or Basic and a token-like
// value of at least 8 non-space characters, so `authorization: basic setup` in prose stays intact. Fix round 4
// (NM3-1): the separators are spaces or tabs, so the header and a token on the next line are never joined.
const AUTHORIZATION_HEADER_PATTERN = /(authorization:[ \t]*(?:bearer|basic)[ \t]+)\S{8,}/gi;

/** A URL whose only userinfo is the fallback's own marker is already masked; re-parsing it must not change it. */
function redactUrl(match: string): string {
  try {
    const parsed = new URL(match);
    if (parsed.username === MASKED_USERINFO && parsed.password === "") return match;
  } catch {
    return match;
  }
  return redactRegistryUrl(match);
}

/**
 * Masks registry credentials in npm output: URL userinfo is stripped (spec §11.5's no-marker convention), a
 * userinfo that can't be parsed becomes `scheme://***@`, and `_authToken`/`_auth`/`_password` values and
 * Authorization tokens become `***`. Never throws.
 */
export function maskCredentials(text: string): string {
  try {
    const withoutUrlCredentials = text.replace(URL_PATTERN, redactUrl);
    const withoutUserinfo = withoutUrlCredentials.replace(
      USERINFO_FALLBACK_PATTERN,
      (_full, scheme: string) => `${scheme}${MASKED_USERINFO}@`,
    );
    const withoutAuthValues = withoutUserinfo.replace(
      AUTH_VALUE_PATTERN,
      (_full, before: string, key: string, separator: string, value: string) => {
        const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
        return `${before}${key}${separator}${quote}***${quote}`;
      },
    );
    return withoutAuthValues.replace(AUTHORIZATION_HEADER_PATTERN, (_full, prefix: string) => `${prefix}***`);
  } catch {
    return text;
  }
}

/** Fix round 3: the index just past the last line break (`\n` or `\r`) in `text`, or -1 when it has none. */
export function lastLineBreakEnd(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) return index + 1;
  }
  return -1;
}
