const WHOLE_VALUE = /^(?:<.*>|replace[-_ ]?me|changeme|change[-_ ]?me|your[-_ ].*|todo|xxx+|dummy|example|demo|test|fake|secret|password|placeholder|none|null)$/i;
const TOKENS = new Set(["replace", "me", "changeme", "change", "placeholder", "your", "todo", "xxx", "dummy", "example", "sample", "fake", "demo", "secret"]);
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Hostnames reserved for documentation/testing (RFC 2606, RFC 6761). */
const RESERVED_HOST = /(^|\.)(?:example\.(?:com|org|net)|test|invalid)$/i;
/**
 * True when a value is obviously not a real secret: `<REPLACE_ME>`, `changeme`,
 * `your-api-key-here`, `demo-token`, `https://api.example.test`, and friends.
 *
 * URLs are judged only by their host: a real internal host is never called a
 * placeholder just because the path contains a word like "test".
 *
 * Env Doctor still copies template values into `.env` so the file is complete —
 * but it never counts that as a verified repair, and it says so out loud.
 */
export function looksLikePlaceholder(value) {
    const trimmed = value.trim().replace(/^["']|["']$/g, "");
    if (!trimmed)
        return true;
    if (/^<.*>$/.test(trimmed))
        return true;
    if (WHOLE_VALUE.test(trimmed))
        return true;
    if (URLISH.test(trimmed)) {
        try {
            return RESERVED_HOST.test(new URL(trimmed).hostname);
        }
        catch {
            return false;
        }
    }
    const tokens = trimmed.toLowerCase().split(/[-_.\s:/]+/).filter(Boolean);
    return tokens.some(token => TOKENS.has(token));
}
export { TOKENS, WHOLE_VALUE };
