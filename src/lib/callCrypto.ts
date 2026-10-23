import { sha256 } from "js-sha256";

// Call-signal authentication — a byte-for-byte port of the web
// engine's scheme (hcroom src/lib/calls.ts, audit-2 C1):
//   mac = b64url( HMAC-SHA256( b64urlDecode(secret),
//              utf8(`${callId}\n${kind}\n${canonicalJson(payload)}`) ) )
// The web uses WebCrypto; here HMAC is composed by hand over
// js-sha256 (verified against RFC 4231 vectors + Node's WebCrypto).

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Ported verbatim from the web (key order must never matter). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => {
      const v = obj[k];
      return v !== undefined && typeof v !== "function" && typeof v !== "symbol";
    })
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function utf8(str: string): number[] {
  // TextEncoder is not guaranteed in Hermes; encode manually.
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(++i);
      cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return out;
}

function sha256Bytes(data: number[]): number[] {
  return sha256.array(data);
}

/** HMAC-SHA256 (RFC 2104) over js-sha256. */
export function hmacSha256(key: Uint8Array, msg: number[]): Uint8Array {
  const BLOCK = 64;
  let k: number[] = Array.from(key);
  if (k.length > BLOCK) k = sha256Bytes(k);
  while (k.length < BLOCK) k.push(0);
  const ipad = k.map((b) => b ^ 0x36);
  const opad = k.map((b) => b ^ 0x5c);
  const inner = sha256Bytes([...ipad, ...msg]);
  return new Uint8Array(sha256Bytes([...opad, ...inner]));
}

export function computeSignalMac(
  secret: string,
  kind: "offer" | "answer" | "ice",
  callId: string,
  payload: unknown,
): string {
  const key = b64urlDecode(secret);
  const msg = utf8(`${callId}\n${kind}\n${canonicalJson(payload)}`);
  return b64urlEncode(hmacSha256(key, msg));
}

export function verifySignalMac(
  secret: string | null | undefined,
  kind: "offer" | "answer" | "ice",
  callId: string,
  payload: unknown,
  mac: string | undefined,
): boolean {
  if (!secret || !mac) return false;
  try {
    const expected = b64urlDecode(computeSignalMac(secret, kind, callId, payload));
    const actual = b64urlDecode(mac);
    if (actual.length !== expected.length) return false;
    // Constant-time compare (same hardening as the web).
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
    return diff === 0;
  } catch {
    return false;
  }
}

/** Fresh per-call secret: 32 random bytes, base64url (web parity). */
export function generateCallSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}
