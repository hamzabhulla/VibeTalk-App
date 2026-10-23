import AsyncStorage from "@react-native-async-storage/async-storage";
import { p256 } from "@noble/curves/nist";
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { supabase } from "./supabase";
import { b64urlEncode, b64urlDecode } from "./callCrypto";
import { registerE2eeHooks } from "./sync";

// End-to-end encryption — a faithful port of the web's scheme
// (hcroom src/lib/e2ee.ts), implemented on the audited @noble
// libraries (pure JS, no native code) and cross-verified against
// WebCrypto in Node (encrypt with WebCrypto -> decrypt here, and
// the reverse).
//
// Wire format: body = "E2E1:" + b64url(utf8(JSON envelope))
//   envelope v2 = { v: 2, r: roomId, s: senderPublicRaw,
//     n: msgNonce, c: msgCiphertext,
//     k: { userId: { n: "saltB64.wrapNonceB64", c: wrappedKey } } }
//   message: AES-256-GCM(msgKey, nonce, plaintext, AAD =
//     utf8(`vibetalk-e2ee-v2:${roomId}:${senderId}`))
//   wrap: KEK = HKDF-SHA256(ECDH X-coordinate, salt16,
//     info "vibetalk-e2ee-v1") ; AES-256-GCM(KEK, nonce12, msgKey)
//
// Key storage differs from the web by platform: the web keeps a
// non-extractable WebCrypto key in IndexedDB (anti-XSS); here the
// private scalar lives in the app-sandboxed AsyncStorage. One
// published key per account (profiles.e2e_public_key) — the same
// single-key semantics (and limits) as the web.

export const E2EE_PREFIX = "E2E1:";

export class E2EENotReadyError extends Error {
  constructor(missingNames: string[]) {
    super(
      missingNames.length === 1
        ? `${missingNames[0]} hasn't set up encryption yet`
        : `${missingNames.join(", ")} haven't set up encryption yet`,
    );
    this.name = "E2EENotReadyError";
  }
}

export function isEncryptedBody(body: string | null | undefined): boolean {
  return !!body && body.startsWith(E2EE_PREFIX);
}

// ---- UTF-8 (Hermes has no guaranteed TextEncoder) ----

function utf8Encode(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(++i);
      cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
      );
      i += 3;
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
      i += 4;
    }
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

// ---- Keypair (per user, stored on device) ----

type StoredKeypair = {
  privateScalar: string; // b64url of the 32-byte scalar
  publicRaw: string; // b64url of the 65-byte uncompressed point
  published?: boolean;
};

const storeKey = (uid: string) => `vt-e2ee-${uid}`;
let keypairCache = new Map<string, StoredKeypair>();

async function loadKeypair(uid: string): Promise<StoredKeypair | null> {
  const hit = keypairCache.get(uid);
  if (hit) return hit;
  const raw = await AsyncStorage.getItem(storeKey(uid));
  if (!raw) return null;
  try {
    const kp = JSON.parse(raw) as StoredKeypair;
    keypairCache.set(uid, kp);
    return kp;
  } catch {
    return null;
  }
}

async function saveKeypair(uid: string, kp: StoredKeypair) {
  keypairCache.set(uid, kp);
  await AsyncStorage.setItem(storeKey(uid), JSON.stringify(kp));
}

async function publishKey(uid: string, publicRaw: string): Promise<boolean> {
  const { error } = await supabase
    .from("profiles")
    .update({ e2e_public_key: publicRaw })
    .eq("id", uid);
  if (error) {
    console.warn("[e2ee] publish failed:", error.message);
    return false;
  }
  return true;
}

async function fetchServerKey(uid: string): Promise<string | null | undefined> {
  const { data, error } = await supabase
    .from("profiles")
    .select("e2e_public_key")
    .eq("id", uid)
    .maybeSingle();
  if (error) return undefined; // unknown (column/table issue) — don't fight it
  return (data as any)?.e2e_public_key ?? null;
}

/** Mirrors the web's ensureKeypair: local key wins, a differing
 *  server key is reclaimed by republishing the local one. */
export async function ensureKeypair(uid: string): Promise<StoredKeypair> {
  const stored = await loadKeypair(uid);
  const serverKey = await fetchServerKey(uid);
  if (stored) {
    if (typeof serverKey === "string" && serverKey !== stored.publicRaw) {
      if (await publishKey(uid, stored.publicRaw)) {
        stored.published = true;
        await saveKeypair(uid, stored);
      }
    } else if (stored.published === false || serverKey === null) {
      if (await publishKey(uid, stored.publicRaw)) {
        stored.published = true;
        await saveKeypair(uid, stored);
      }
    }
    return stored;
  }
  const scalar = newSecretKey();
  const pub = p256.getPublicKey(scalar, false);
  const kp: StoredKeypair = {
    privateScalar: b64urlEncode(scalar),
    publicRaw: b64urlEncode(pub),
    published: false,
  };
  await saveKeypair(uid, kp);
  if (await publishKey(uid, kp.publicRaw)) {
    kp.published = true;
    await saveKeypair(uid, kp);
  }
  return kp;
}

// ---- Crypto primitives (noble) ----

// noble-curves renamed a few APIs between 1.x and 2.x - tolerate both so a
// minor-version bump can never silently break every encrypted send.
function newSecretKey(): Uint8Array {
  const u: any = p256.utils;
  return (u.randomSecretKey ?? u.randomPrivateKey).call(u);
}

function assertValidPoint(pubBytes: Uint8Array): void {
  const P: any = p256.Point;
  if (typeof P.fromBytes === "function") P.fromBytes(pubBytes);
  else P.fromHex(pubBytes); // throws on an invalid curve point
}

function ecdhSharedX(myScalar: Uint8Array, theirPubRaw: Uint8Array): Uint8Array {
  const shared = p256.getSharedSecret(myScalar, theirPubRaw) as any;
  const bytes: Uint8Array =
    shared instanceof Uint8Array ? shared : shared.toRawBytes(false);
  return bytes.slice(1, 33); // X coordinate (WebCrypto deriveBits(256))
}

function deriveKek(
  myScalar: Uint8Array,
  theirPubRaw: Uint8Array,
  salt: Uint8Array,
): Uint8Array {
  const shared = ecdhSharedX(myScalar, theirPubRaw);
  return hkdf(sha256, shared, salt, utf8Encode("vibetalk-e2ee-v1"), 32);
}

function aesEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): { nonce: string; ciphertext: string } {
  const nonce = randomBytes(12);
  const ct = gcm(key, nonce, aad).encrypt(plaintext);
  return { nonce: b64urlEncode(nonce), ciphertext: b64urlEncode(ct) };
}

function aesDecrypt(
  key: Uint8Array,
  nonceB64: string,
  ctB64: string,
  aad?: Uint8Array,
): Uint8Array {
  return gcm(key, b64urlDecode(nonceB64), aad).decrypt(b64urlDecode(ctB64));
}

function e2eeAad(roomId: string, senderId: string): Uint8Array {
  return utf8Encode(`vibetalk-e2ee-v2:${roomId}:${senderId}`);
}

// ---- Room member keys (same reads the web's server fn performs) ----

type MemberKey = { user_id: string; e2e_public_key: string | null; display_name: string };

function transientError(message: string): Error {
  // `transient` tells the outbox to keep the message PENDING and retry
  // instead of marking it failed (see isTransientError in sync.ts).
  return Object.assign(new Error(message), { transient: true });
}

async function getRoomMemberKeys(roomId: string): Promise<MemberKey[]> {
  // A failed lookup must THROW: silently returning [] used to produce an
  // envelope with no wrapped keys (an undecryptable message, even for
  // the sender) whenever the network flaked mid-send.
  const { data: members, error: memErr } = await supabase
    .from("room_members")
    .select("user_id")
    .eq("room_id", roomId);
  if (memErr) throw transientError(memErr.message);
  const ids = (members ?? []).map((m: any) => m.user_id as string);
  if (!ids.length) return [];
  const { data: profs, error: profErr } = await supabase
    .from("profiles")
    .select("id, display_name, e2e_public_key")
    .in("id", ids);
  if (profErr) throw transientError(profErr.message);
  const byId = new Map((profs ?? []).map((p: any) => [p.id, p]));
  return ids.map((id) => {
    const p: any = byId.get(id);
    return {
      user_id: id,
      e2e_public_key: p?.e2e_public_key ?? null,
      display_name: p?.display_name ?? "Someone",
    };
  });
}

// ---- Encrypt / decrypt ----

export async function encryptForRoom(
  roomId: string,
  plaintext: string,
  myUserId: string,
): Promise<string> {
  const memberKeys = await getRoomMemberKeys(roomId);
  const serverKeyForSelf = memberKeys.find(
    (m) => m.user_id === myUserId,
  )?.e2e_public_key;
  void serverKeyForSelf; // ensureKeypair re-reads it; kept for parity
  const kp = await ensureKeypair(myUserId);
  const myScalar = b64urlDecode(kp.privateScalar);

  const recipients: { userId: string; publicRaw: string; name: string }[] = [];
  const missing: string[] = [];
  for (const m of memberKeys) {
    if (m.user_id === myUserId) {
      recipients.push({ userId: m.user_id, publicRaw: kp.publicRaw, name: m.display_name });
      continue;
    }
    if (!m.e2e_public_key) {
      missing.push(m.display_name);
      continue;
    }
    recipients.push({ userId: m.user_id, publicRaw: m.e2e_public_key, name: m.display_name });
  }
  if (missing.length) throw new E2EENotReadyError(missing);
  // The sender must always be able to read their own message.
  if (!recipients.some((r) => r.userId === myUserId)) {
    recipients.push({ userId: myUserId, publicRaw: kp.publicRaw, name: "You" });
  }

  const messageKey = randomBytes(32);
  const { nonce, ciphertext } = aesEncrypt(
    messageKey,
    utf8Encode(plaintext),
    e2eeAad(roomId, myUserId),
  );
  const wrapped: Record<string, { n: string; c: string }> = {};
  for (const r of recipients) {
    let pubBytes: Uint8Array;
    try {
      pubBytes = b64urlDecode(r.publicRaw);
      // Validate the point before use (garbage key bricks the room).
      assertValidPoint(pubBytes);
    } catch {
      throw new E2EENotReadyError([r.name]);
    }
    const salt = randomBytes(16);
    const kek = deriveKek(myScalar, pubBytes, salt);
    const w = aesEncrypt(kek, messageKey);
    wrapped[r.userId] = { n: `${b64urlEncode(salt)}.${w.nonce}`, c: w.ciphertext };
  }
  const envelope = {
    v: 2,
    r: roomId,
    s: kp.publicRaw,
    n: nonce,
    c: ciphertext,
    k: wrapped,
  };
  return `${E2EE_PREFIX}${b64urlEncode(utf8Encode(JSON.stringify(envelope)))}`;
}

type WireEnvelope = {
  v?: number;
  r?: string;
  s: string;
  n: string;
  c: string;
  k: Record<string, { n: string; c: string }>;
};

export function hasWrappedKey(body: string, userId: string): boolean {
  try {
    if (!isEncryptedBody(body)) return false;
    const env = JSON.parse(
      utf8Decode(b64urlDecode(body.slice(E2EE_PREFIX.length))),
    ) as WireEnvelope;
    return !!env.k?.[userId];
  } catch {
    return false;
  }
}

/**
 * Web's isCorruptEnvelope: an "E2E1:" body that fails to parse or
 * whose k is not an object is CORRUPT (shows "Couldn't decrypt"),
 * as opposed to a well-formed envelope simply not wrapped for me
 * ("Sent before you joined").
 */
export function isCorruptEnvelope(body: string | null | undefined): boolean {
  if (!isEncryptedBody(body)) return false;
  try {
    const env = JSON.parse(
      utf8Decode(b64urlDecode(body!.slice(E2EE_PREFIX.length))),
    ) as WireEnvelope;
    return typeof env.k !== "object" || env.k === null;
  } catch {
    return true;
  }
}

/** Decrypt one stored body; null when impossible (web semantics). */
export async function decryptBody(
  body: string | null | undefined,
  myUserId: string,
  opts: { roomId: string; senderId: string },
): Promise<string | null> {
  if (!isEncryptedBody(body)) return body ?? null;
  try {
    const env = JSON.parse(
      utf8Decode(b64urlDecode(body!.slice(E2EE_PREFIX.length))),
    ) as WireEnvelope;
    const mine = env.k?.[myUserId];
    if (!mine || !env.s) return null;
    if (typeof env.r === "string" && env.r !== opts.roomId) return null;
    const aad =
      env.v === 2
        ? e2eeAad(opts.roomId, opts.senderId)
        : env.v === undefined || env.v === 1
          ? undefined
          : null;
    if (aad === null) return null;
    // Local-only load: viewing must never generate/publish a key.
    const local = await loadKeypair(myUserId);
    if (!local) return null;
    const myScalar = b64urlDecode(local.privateScalar);
    const [saltB64, wrapNonce] = mine.n.split(".");
    if (!saltB64 || !wrapNonce) return null;
    const kek = deriveKek(myScalar, b64urlDecode(env.s), b64urlDecode(saltB64));
    const messageKey = aesDecrypt(kek, wrapNonce, mine.c);
    const pt = aesDecrypt(messageKey, env.n, env.c, aad);
    return utf8Decode(pt);
  } catch {
    return null;
  }
}

// Register with the sync engine: pushes into E2EE rooms encrypt
// through here; pulls decrypt through here.
registerE2eeHooks({
  encryptForRoom: (roomId, plaintext, uid) => encryptForRoom(roomId, plaintext, uid),
  decryptBody: (body, uid, opts) => decryptBody(body, uid, opts),
  hasWrappedKey: (body, uid) => hasWrappedKey(body, uid),
  isCorrupt: (body) => isCorruptEnvelope(body),
});
