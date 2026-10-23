import { uuidv4 } from "../src/lib/uuid";
import {
  b64urlDecode,
  b64urlEncode,
  canonicalJson,
  hmacSha256,
} from "../src/lib/callCrypto";

// These cover the pure-JS helpers the app depends on at runtime
// (no native modules involved, so they run under plain Jest).

describe("uuidv4", () => {
  it("returns RFC 4122 v4 UUIDs", () => {
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (let i = 0; i < 50; i++) expect(uuidv4()).toMatch(re);
  });

  it("does not collide", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(uuidv4());
    expect(seen.size).toBe(1000);
  });

  it("works when crypto.randomUUID is missing (Hermes)", () => {
    const g: any = globalThis;
    const original = g.crypto;
    g.crypto = {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = (i * 31 + 7) & 0xff;
        return a;
      },
    };
    try {
      expect(uuidv4()).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      g.crypto = original;
    }
  });
});

describe("callCrypto", () => {
  it("matches the RFC 4231 HMAC-SHA256 test vector (case 2)", () => {
    const key = new TextEncoder().encode("Jefe");
    const msg = Array.from(new TextEncoder().encode("what do ya want for nothing?"));
    const mac = hmacSha256(key, msg);
    const hex = Array.from(mac)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("canonicalJson ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("base64url round-trips", () => {
    const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255, 1, 2, 3]);
    expect(Array.from(b64urlDecode(b64urlEncode(bytes)))).toEqual(
      Array.from(bytes),
    );
  });
});
