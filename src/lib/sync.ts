import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { AppState } from "react-native";
import { Q } from "@nozbe/watermelondb";
import { supabase } from "./supabase";
import { parseMeta, serverMeta } from "./attachmentMeta";
import { uuidv4 } from "./uuid";
import {
  database,
  profilesCol,
  roomsCol,
  messagesCol,
  reactionsCol,
  upsertManyById,
  upsertById,
} from "../db";
import type { RealtimeChannel } from "@supabase/supabase-js";

// Offline-first sync (the WhatsApp model): WatermelonDB on the
// device is the source of truth for READS; Supabase is delivery +
// cross-device sync. Sending writes locally first (status 'pending')
// and flushes when the network allows — the UI never waits on net.

let currentUserId: string | null = null;
let openRoomId: string | null = null;
let channel: RealtimeChannel | null = null;
let roomsChannel: RealtimeChannel | null = null;
let syncing = false;
let resyncQueued = false;
let outboxTimer: ReturnType<typeof setInterval> | null = null;

// Server policy (messages_update_own_recent): a message may only be
// edited or deleted within 5 minutes of sending. The UI mirrors it.
export const EDIT_WINDOW_MS = 5 * 60 * 1000;

// ---- small helpers -------------------------------------------------

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Let the UI thread breathe during long CPU-bound loops (E2EE). */
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/** True for "the network is the problem" errors: the message must stay
 *  PENDING and be retried later, not be marked failed forever. Server
 *  rejections (RLS, constraints) carry a Postgres/PostgREST `code`. */
export function isTransientError(e: any): boolean {
  if (!e) return false;
  if (e.transient === true) return true;
  const code = e.code ?? e.status ?? e.statusCode;
  if (code && String(code) !== "0" && String(code) !== "") {
    const c = String(code);
    // 5xx / 408 / 429 are retryable; Postgres SQLSTATEs and 4xx are not.
    return /^(5\d\d|408|429)$/.test(c);
  }
  const msg = String(e.message ?? e);
  return /network|fetch|timeout|timed out|offline|socket|connection|abort/i.test(
    msg,
  );
}

export function setOpenRoom(id: string | null) {
  openRoomId = id;
  if (id) {
    void markRoomRead(id);
    void pullRoomReactions(id);
    void pullReceipts([id]);
  }
}

function lastPullKey(uid: string) {
  return `vt-last-pull-${uid}`;
}

type ServerMessage = {
  id: string;
  room_id: string;
  user_id: string;
  body: string | null;
  type: string;
  attachment_url: string | null;
  attachment_meta: any;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
};

async function recomputeRoomDenorm(roomId: string) {
  try {
    const room: any = await roomsCol.find(roomId);
    const latest = await messagesCol
      .query(
        Q.where("room_id", roomId),
        Q.sortBy("created_at", Q.desc),
        Q.take(1),
      )
      .fetch();
    await database.write(async () => {
      await room.update((r: any) => {
        if (latest.length) {
          const m: any = latest[0];
          r.lastMessageBody = previewFor(m.msgType, m.body);
          r.lastMessageAt = m.createdAt.getTime();
          r.lastSenderId = m.senderId;
        } else {
          r.lastMessageBody = undefined;
          r.lastMessageAt = undefined;
          r.lastSenderId = undefined;
        }
      });
    });
  } catch {
    /* room not mirrored */
  }
}

// A realtime event for a room we don't mirror yet (someone started a new
// chat with us) or a membership change: pull again shortly. Debounced.
let resyncTimer: ReturnType<typeof setTimeout> | null = null;
function requestResync() {
  if (resyncTimer || !currentUserId) return;
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    const uid = currentUserId;
    if (uid) void pullEverything(uid).catch(() => {});
  }, 1500);
}

/**
 * Apply a batch of server messages in ONE writer transaction.
 * (The old code did ~4 separate DB transactions per message — a first
 * sync of 10k messages meant 40k transactions.)
 *  - E2EE bodies are decrypted first, outside the writer, yielding to
 *    the UI every few messages (pure-JS ECDH is CPU heavy).
 *  - unread is only bumped for messages that are NEW locally, so a
 *    realtime echo + a pull can never double count.
 */
async function applyServerMessages(
  msgs: ServerMessage[],
  countUnread: boolean,
): Promise<void> {
  if (msgs.length === 0) return;
  const me = currentUserId;

  const dedup = new Map<string, ServerMessage>();
  for (const m of msgs) dedup.set(m.id, m);
  const list = [...dedup.values()];
  const live = list.filter((m) => !m.deleted_at);
  const deletes = list.filter((m) => !!m.deleted_at);

  const roomRows = (await roomsCol.query().fetch()) as any[];
  const roomById = new Map<string, any>(roomRows.map((r) => [r.id, r]));

  const existing = new Map<string, any>();
  for (const part of chunk(
    list.map((m) => m.id),
    400,
  )) {
    const rows = (await messagesCol
      .query(Q.where("id", Q.oneOf(part)))
      .fetch()) as any[];
    for (const r of rows) existing.set(r.id, r);
  }

  // E2EE: decrypt at the boundary — the device DB stores plaintext
  // (or the web's exact placeholders when decryption is impossible).
  const bodies = new Map<string, string>();
  let decrypted = 0;
  for (const m of live) {
    const room = roomById.get(m.room_id);
    let display = m.body ?? "";
    const looksEnvelope = !!m.body?.startsWith("E2E1:");
    if (looksEnvelope && (room?.isE2ee || !room) && me) {
      const local = existing.get(m.id);
      if (local?.status === "pending" && local.senderId === me) {
        // My own outbox echo: keep the local plaintext copy.
        display = local.body;
      } else if (e2eeHooks) {
        const pt = await e2eeHooks.decryptBody(m.body, me, {
          roomId: m.room_id,
          senderId: m.user_id,
        });
        display =
          pt ??
          (e2eeHooks.isCorrupt(m.body!) ||
          e2eeHooks.hasWrappedKey(m.body!, me)
            ? "Couldn't decrypt this message"
            : "🔒 Sent before you joined");
        if (++decrypted % 4 === 0) await yieldToUi();
      } else {
        display = "🔒 Encrypted message";
      }
    }
    bodies.set(m.id, display);
  }

  type Touch = { bestMs: number; body: string; sender: string; unread: number };
  const touched = new Map<string, Touch>();
  const unknownRooms = new Set<string>();
  const destroyedRooms = new Set<string>();

  await database.write(async () => {
    const ops: any[] = [];
    for (const m of live) {
      const createdMs = new Date(m.created_at).getTime();
      const local = existing.get(m.id);
      const display = bodies.get(m.id) ?? "";
      const apply = (rec: any) => {
        rec.roomId = m.room_id;
        rec.senderId = m.user_id;
        rec.body = display;
        rec.msgType = m.type;
        rec.attachmentUrl = m.attachment_url ?? undefined;
        // Merge, never overwrite: the server meta is only {name,size,
        // mime}; the local-only keys (w/h/durationMs, plus localUri
        // until the upload lands) live solely in the local copy.
        if (m.attachment_meta) {
          const prev = parseMeta(rec.attachmentMeta);
          const merged: Record<string, unknown> = {
            ...(m.attachment_meta as Record<string, unknown>),
          };
          if (prev.w) merged.w = prev.w;
          if (prev.h) merged.h = prev.h;
          if (prev.durationMs) merged.durationMs = prev.durationMs;
          if (prev.localUri && !m.attachment_url)
            merged.localUri = prev.localUri;
          rec.attachmentMeta = JSON.stringify(merged);
        } else {
          rec.attachmentMeta = undefined;
        }
        rec.createdAt = new Date(createdMs);
        rec.editedAt = m.edited_at ? new Date(m.edited_at).getTime() : undefined;
        rec.deletedAt = undefined;
        // Never resurrect a pending local copy's status backwards.
        if (rec.status !== "pending") rec.status = "synced";
      };
      ops.push(
        local
          ? local.prepareUpdate(apply)
          : (messagesCol as any).prepareCreate((rec: any) => {
              rec._raw.id = m.id;
              apply(rec);
            }),
      );

      const room = roomById.get(m.room_id);
      if (!room) {
        unknownRooms.add(m.room_id);
        continue;
      }
      const t: Touch = touched.get(m.room_id) ?? {
        bestMs: -1,
        body: "",
        sender: "",
        unread: 0,
      };
      if (createdMs >= t.bestMs) {
        t.bestMs = createdMs;
        t.body = room.isE2ee
          ? "🔒 Encrypted message"
          : previewFor(m.type, m.body);
        t.sender = m.user_id;
      }
      if (
        countUnread &&
        !local &&
        m.user_id !== me &&
        openRoomId !== m.room_id
      ) {
        t.unread += 1;
      }
      touched.set(m.room_id, t);
    }
    for (const d of deletes) {
      const local = existing.get(d.id);
      if (local) {
        ops.push(local.prepareDestroyPermanently());
        destroyedRooms.add(d.room_id);
      }
    }
    for (const [rid, t] of touched) {
      const room = roomById.get(rid);
      ops.push(
        room.prepareUpdate((r: any) => {
          if (!r.lastMessageAt || t.bestMs >= r.lastMessageAt) {
            r.lastMessageBody = t.body;
            r.lastMessageAt = t.bestMs;
            r.lastSenderId = t.sender;
          }
          if (t.unread) r.unreadCount = (r.unreadCount ?? 0) + t.unread;
        }),
      );
    }
    if (ops.length) await database.batch(...ops);
  });

  for (const rid of destroyedRooms) await recomputeRoomDenorm(rid);
  if (unknownRooms.size) requestResync();
  if (
    openRoomId &&
    me &&
    live.some((m) => m.room_id === openRoomId && m.user_id !== me)
  ) {
    scheduleMarkRead(openRoomId);
  }
}

async function applyServerMessage(m: ServerMessage, countUnread: boolean) {
  await applyServerMessages([m], countUnread);
}

/** Chat-list preview for a message (call entries get the web's
 *  friendly label, never the raw JSON body). */
export function previewFor(type: string, body: string | null): string {
  if (type === "call") {
    try {
      const p = JSON.parse(body ?? "");
      const t = p.type ?? p.call;
      const label = t === "video" ? "Video call" : "Voice call";
      const icon = t === "video" ? "📹" : "📞";
      if (p.status === "missed") return `${icon} Missed ${t} call`;
      if (p.status === "declined") return `${icon} ${label} · Declined`;
      if (p.status === "cancelled") return `${icon} Cancelled ${t} call`;
      if (p.status === "failed") return `${icon} ${label} · Failed`;
      if (typeof p.duration === "number")
        return `${icon} ${label} · ${Math.floor(p.duration / 60)}:${String(p.duration % 60).padStart(2, "0")}`;
      return `${icon} ${label}`;
    } catch {
      return "📞 Call";
    }
  }
  if (type === "text") return body ?? "";
  return `[${type}]`;
}

export async function markRoomRead(roomId: string) {
  try {
    const room: any = await roomsCol.find(roomId);
    if (room.unreadCount) {
      await database.write(async () => {
        await room.update((r: any) => {
          r.unreadCount = 0;
        });
      });
    }
  } catch {
    /* room not local yet */
  }
  // Web parity: the read state lives server-side (read_receipts,
  // one row per room+user) so other devices and ticks agree.
  if (!currentUserId) return;
  // Never behind the newest message: a slow device clock must not leave
  // messages "unread" (and the sender without ticks) forever.
  let ms = Date.now();
  try {
    const latest = await messagesCol
      .query(
        Q.where("room_id", roomId),
        Q.sortBy("created_at", Q.desc),
        Q.take(1),
      )
      .fetch();
    if (latest[0]) ms = Math.max(ms, (latest[0] as any).createdAt.getTime());
  } catch {}
  try {
    const { error } = await supabase
      .from("read_receipts")
      .upsert(
        {
          room_id: roomId,
          user_id: currentUserId,
          last_read_at: new Date(ms).toISOString(),
        },
        { onConflict: "room_id,user_id" },
      );
    if (error) console.warn("[receipts] mark read failed:", error.message);
  } catch (e: any) {
    console.warn("[receipts] mark read failed:", e?.message ?? e);
  }
  setReceipt(roomId, currentUserId, ms);
}

// New messages arriving while a chat is open count as read right away
// (debounced so a burst of messages is a single receipt write).
const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleMarkRead(roomId: string) {
  if (readTimers.has(roomId)) return;
  readTimers.set(
    roomId,
    setTimeout(() => {
      readTimers.delete(roomId);
      if (openRoomId === roomId) void markRoomRead(roomId);
    }, 700),
  );
}

// ------------------------------------------------------------------
// Read receipts (per room+user last_read_at) — ephemeral store.
// ------------------------------------------------------------------

const receiptsByRoom = new Map<string, Map<string, number>>();
const ephemeralListeners = new Set<() => void>();

export function onEphemeralChange(fn: () => void) {
  ephemeralListeners.add(fn);
  return () => {
    ephemeralListeners.delete(fn);
  };
}

function notifyEphemeral() {
  for (const fn of [...ephemeralListeners]) fn();
}

function setReceipt(roomId: string, userId: string, ms: number) {
  let room = receiptsByRoom.get(roomId);
  if (!room) {
    room = new Map();
    receiptsByRoom.set(roomId, room);
  }
  if ((room.get(userId) ?? 0) < ms) {
    room.set(userId, ms);
    notifyEphemeral();
  }
}

// Full member rosters per room (from the pullEverything members
// fetch) — read ticks follow the web's rule: a DM ticks when the
// partner read it; a GROUP ticks only when EVERY other member read
// it (the web snapshots recipient_count at send time; the live
// roster is the closest client-side equivalent — a member who
// joined later resolves the tick the first time they open the room).
const membersByRoom = new Map<string, Set<string>>();

/**
 * True when the message counts as read under the web's rule: in a
 * DM, the partner's receipt covers it; in a group, EVERY other
 * member's receipt must cover it. Without roster knowledge, falls
 * back to the any-reader rule.
 */
export function someoneReadAt(roomId: string, createdMs: number): boolean {
  const room = receiptsByRoom.get(roomId);
  if (!room) return false;
  const roster = membersByRoom.get(roomId);
  if (!roster || roster.size === 0) {
    for (const [uid, ms] of room) {
      if (uid !== currentUserId && ms >= createdMs) return true;
    }
    return false;
  }
  let sawOther = false;
  for (const uid of roster) {
    if (uid === currentUserId) continue;
    sawOther = true;
    if ((room.get(uid) ?? 0) < createdMs) return false;
  }
  return sawOther;
}

/** Returns true only when the receipts were fetched successfully. */
export async function pullReceipts(roomIds: string[]): Promise<boolean> {
  if (!roomIds.length) return true;
  for (const part of chunk(roomIds, 40)) {
    const { data, error } = await supabase
      .from("read_receipts")
      .select("room_id, user_id, last_read_at")
      .in("room_id", part);
    if (error) {
      console.warn("[receipts] pull failed:", error.message);
      return false;
    }
    for (const r of data ?? []) {
      setReceipt(
        (r as any).room_id,
        (r as any).user_id,
        new Date((r as any).last_read_at).getTime(),
      );
    }
  }
  return true;
}

/** Unread badge = peer messages newer than MY last_read_at, derived from
 *  local data — correct for messages that arrived while the app was
 *  closed (the old code only counted live realtime inserts). */
async function recomputeUnread(roomIds: string[], uid: string) {
  for (const part of chunk(roomIds, 400)) {
    const rooms = (await roomsCol
      .query(Q.where("id", Q.oneOf(part)))
      .fetch()) as any[];
    const updates: Array<{ room: any; target: number }> = [];
    for (const room of rooms) {
      let target = 0;
      if (openRoomId !== room.id) {
        const lastRead = receiptsByRoom.get(room.id)?.get(uid) ?? 0;
        target = await messagesCol
          .query(
            Q.where("room_id", room.id),
            Q.where("sender_id", Q.notEq(uid)),
            Q.where("created_at", Q.gt(lastRead)),
          )
          .fetchCount();
      }
      if ((room.unreadCount ?? 0) !== target) updates.push({ room, target });
    }
    if (updates.length) {
      await database.write(async () => {
        await database.batch(
          ...updates.map(({ room, target }) =>
            room.prepareUpdate((r: any) => {
              r.unreadCount = target;
            }),
          ),
        );
      });
    }
  }
}

// ------------------------------------------------------------------
// Typing indicators (typing_status rows, receipt-time freshness —
// mirrors the web's audit-hardened approach).
// ------------------------------------------------------------------

const typingByRoom = new Map<string, Map<string, number>>();
const TYPING_FRESH_MS = 6000;

export function typingUsers(roomId: string): string[] {
  const room = typingByRoom.get(roomId);
  if (!room) return [];
  const now = Date.now();
  const out: string[] = [];
  for (const [uid, ms] of room) {
    if (uid !== currentUserId && now - ms < TYPING_FRESH_MS) out.push(uid);
  }
  return out;
}

function applyTyping(roomId: string, userId: string, present: boolean) {
  let room = typingByRoom.get(roomId);
  if (!room) {
    room = new Map();
    typingByRoom.set(roomId, room);
  }
  if (present) room.set(userId, Date.now());
  else room.delete(userId);
  notifyEphemeral();
}

const lastTypingSent = new Map<string, number>();

/** Load who is typing in a room right now (room-open catch-up). */
export async function fetchTyping(roomId: string): Promise<void> {
  const since = new Date(Date.now() - 15_000).toISOString();
  const { data } = await supabase
    .from("typing_status")
    .select("user_id")
    .eq("room_id", roomId)
    .gt("updated_at", since);
  for (const r of (data as any[]) ?? []) {
    if (r.user_id !== currentUserId) applyTyping(roomId, r.user_id, true);
  }
}

export async function setTyping(roomId: string) {
  if (!currentUserId) return;
  const now = Date.now();
  if (now - (lastTypingSent.get(roomId) ?? 0) < 2500) return;
  lastTypingSent.set(roomId, now);
  await supabase
    .from("typing_status")
    .upsert({
      room_id: roomId,
      user_id: currentUserId,
      updated_at: new Date().toISOString(),
    })
    .then(({ error }) => {
      if (error) console.warn("[typing] upsert failed:", error.message);
    });
}

export async function clearTyping(roomId: string) {
  if (!currentUserId) return;
  lastTypingSent.delete(roomId);
  await supabase
    .from("typing_status")
    .delete()
    .eq("room_id", roomId)
    .eq("user_id", currentUserId)
    .then(({ error }) => {
      if (error) console.warn("[typing] clear failed:", error.message);
    });
}

// ------------------------------------------------------------------
// Reactions (message_reactions; local id = message|user|emoji).
// ------------------------------------------------------------------

function reactionId(messageId: string, userId: string, emoji: string) {
  return `${messageId}|${userId}|${emoji}`;
}

type ServerReaction = { message_id: string; user_id: string; emoji: string };

function reactionItem(row: ServerReaction) {
  return {
    id: reactionId(row.message_id, row.user_id, row.emoji),
    apply: (rec: any) => {
      rec.messageId = row.message_id;
      rec.userId = row.user_id;
      rec.emoji = row.emoji;
    },
  };
}

async function applyReaction(row: ServerReaction) {
  const it = reactionItem(row);
  await upsertById(reactionsCol as any, it.id, it.apply);
}

async function removeReaction(row: Partial<ServerReaction>) {
  if (!row.message_id || !row.user_id || !row.emoji) {
    if (openRoomId) void pullRoomReactions(openRoomId);
    return;
  }
  try {
    const local: any = await reactionsCol.find(
      reactionId(row.message_id, row.user_id, row.emoji),
    );
    await database.write(async () => {
      await local.destroyPermanently();
    });
  } catch {
    /* not mirrored */
  }
}

export async function pullRoomReactions(roomId: string) {
  // ids only — no need to load every message row of the room.
  const ids = await messagesCol.query(Q.where("room_id", roomId)).fetchIds();
  for (const part of chunk(ids, 300)) {
    const { data, error } = await supabase
      .from("message_reactions")
      .select("message_id, user_id, emoji")
      .in("message_id", part);
    if (error) {
      console.warn("[reactions] pull failed:", error.message);
      return;
    }
    const rows = (data ?? []) as ServerReaction[];
    // Replace semantics for these messages: drop local rows the
    // server no longer has (toggles that happened elsewhere).
    const serverKeys = new Set(
      rows.map((r) => reactionId(r.message_id, r.user_id, r.emoji)),
    );
    const local = (await reactionsCol
      .query(Q.where("message_id", Q.oneOf(part)))
      .fetch()) as any[];
    const stale = local.filter((lr) => !serverKeys.has(lr.id));
    if (stale.length) {
      await database.write(async () => {
        await database.batch(...stale.map((lr) => lr.prepareDestroyPermanently()));
      });
    }
    await upsertManyById(reactionsCol as any, rows.map(reactionItem));
  }
}

/** Same toggle dance as the web: delete-by-key first, else upsert. */
export async function toggleReaction(
  uid: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  const id = reactionId(messageId, uid, emoji);
  let exists = true;
  try {
    await reactionsCol.find(id);
  } catch {
    exists = false;
  }
  // Optimistic local apply.
  if (exists) {
    await removeReaction({ message_id: messageId, user_id: uid, emoji });
  } else {
    await applyReaction({ message_id: messageId, user_id: uid, emoji });
  }
  const { count, error: delErr } = await supabase
    .from("message_reactions")
    .delete({ count: "exact" })
    .eq("message_id", messageId)
    .eq("user_id", uid)
    .eq("emoji", emoji);
  if (delErr) {
    console.warn("[reactions] toggle failed:", delErr.message);
    return;
  }
  if ((count ?? 0) === 0) {
    const { error } = await supabase.from("message_reactions").upsert(
      { message_id: messageId, user_id: uid, emoji },
      { onConflict: "message_id,user_id,emoji", ignoreDuplicates: true },
    );
    if (error) console.warn("[reactions] upsert failed:", error.message);
  }
}

// ------------------------------------------------------------------
// Edit / delete (own messages, inside the server's 5-minute window).
// ------------------------------------------------------------------

export async function editMessage(
  uid: string,
  msg: any,
  newBody: string,
): Promise<boolean> {
  const oldBody = msg.body;
  const oldEdited = msg.editedAt;
  if (msg.status !== "synced") {
    // Not on the server yet — the eventual send encrypts if needed.
    await database.write(async () => {
      await msg.update((r: any) => {
        r.body = newBody;
        r.editedAt = Date.now();
      });
    });
    return true;
  }
  // In an E2EE room the wire body must be a fresh envelope (the DB
  // tamper trigger rejects anything that isn't "E2E1:" there).
  // Encrypt BEFORE touching local state; if a member key is missing
  // the edit fails cleanly with nothing changed.
  let wireBody = newBody;
  const room = await roomsCol.find(msg.roomId).catch(() => null);
  if ((room as any)?.isE2ee) {
    if (!e2eeHooks) return false;
    try {
      wireBody = await e2eeHooks.encryptForRoom(msg.roomId, newBody, uid);
    } catch {
      return false;
    }
  }
  await database.write(async () => {
    await msg.update((r: any) => {
      r.body = newBody;
      r.editedAt = Date.now();
    });
  });
  // The returned row is the success proof: outside the 5-minute RLS
  // window the update succeeds with 0 rows (the web checks this too).
  const { data: updated, error } = await supabase
    .from("messages")
    .update({ body: wireBody, edited_at: new Date().toISOString() })
    .eq("id", msg.id)
    .eq("user_id", uid)
    .select("id");
  if (error || !updated || updated.length === 0) {
    await database.write(async () => {
      await msg.update((r: any) => {
        r.body = oldBody;
        r.editedAt = oldEdited;
      });
    });
    return false;
  }
  return true;
}

export async function deleteMessage(uid: string, msg: any): Promise<boolean> {
  const roomId = msg.roomId;
  if (msg.status === "synced") {
    // HARD delete — the production model: the tamper trigger forbids
    // deleted_at UPDATEs, and the web deletes the row outright. RLS
    // allows own deletes only inside the 5-minute window and returns
    // 0 rows (no error) when it has expired — so the returned row is
    // the success proof, exactly like the web's deleteMessage.
    const { data: deleted, error } = await supabase
      .from("messages")
      .delete()
      .eq("id", msg.id)
      .eq("user_id", uid)
      .select("id");
    if (error || !deleted || deleted.length === 0) return false;
  }
  await database.write(async () => {
    await msg.destroyPermanently();
  });
  await recomputeRoomDenorm(roomId);
  return true;
}

// A message deleted elsewhere (web hard-delete) arrives here via the
// messages DELETE realtime event; deletions that happened while this
// device was offline are healed by reconcileRoomDeletes on room open.
export async function applyServerDelete(messageId: string): Promise<void> {
  const existing = await messagesCol.find(messageId).catch(() => null);
  if (!existing) return;
  const roomId = (existing as any).roomId as string;
  // If the deleted message was an unread one from someone else and
  // the room isn't open, the badge must not keep counting it.
  const wasUnreadPeer =
    openRoomId !== roomId &&
    (existing as any).senderId !== currentUserId &&
    (existing as any).createdAt.getTime() >
      (receiptsByRoom.get(roomId)?.get(currentUserId ?? "") ?? 0);
  await database.write(async () => {
    await existing.destroyPermanently();
  });
  if (wasUnreadPeer) {
    const room: any = await roomsCol.find(roomId).catch(() => null);
    if (room && (room.unreadCount ?? 0) > 0) {
      await database.write(async () => {
        await room.update((r: any) => {
          r.unreadCount = Math.max(0, (r.unreadCount ?? 0) - 1);
        });
      });
    }
  }
  await recomputeRoomDenorm(roomId);
  // Reactions of the gone message are cascade-deleted server-side.
  void pullRoomReactions(roomId);
}

// Offline delete-reconcile for one room: fetch the room's complete
// server id set (paged, id-only) and purge local "synced" messages
// that no longer exist server-side. Aborts WITHOUT purging on any
// fetch error — a partial set must never cause deletions.
// Race-safe: only messages OLDER than the scan start (minus a safety
// margin) are purged, so a message that arrives while the scan runs is
// never mistaken for "deleted". Throttled to one scan per room / 5 min.
const lastReconcile = new Map<string, number>();

export async function reconcileRoomDeletes(roomId: string): Promise<void> {
  const scanStart = Date.now();
  if (scanStart - (lastReconcile.get(roomId) ?? 0) < 5 * 60 * 1000) return;
  const serverIds = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("messages")
      .select("id")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data) return;
    for (const r of data as any[]) serverIds.add(r.id as string);
    if (data.length < PAGE) break;
  }
  lastReconcile.set(roomId, scanStart);
  const cutoff = scanStart - 120_000;
  const locals = (await messagesCol
    .query(Q.where("room_id", roomId), Q.where("status", "synced"))
    .fetch()) as any[];
  const gone = locals.filter(
    (m) => !serverIds.has(m.id) && m.createdAt.getTime() < cutoff,
  );
  if (gone.length === 0) return;
  const goneIds = gone.map((m) => m.id as string);
  await database.write(async () => {
    const ops: any[] = gone.map((m) => m.prepareDestroyPermanently());
    // Their reactions are cascade-gone server-side too — don't
    // leave orphan rows behind locally. (The local reactions table
    // is keyed by message_id only — it has no room_id column.)
    for (const part of chunk(goneIds, 400)) {
      const orphans = (await reactionsCol
        .query(Q.where("message_id", Q.oneOf(part)))
        .fetch()) as any[];
      for (const r of orphans) ops.push(r.prepareDestroyPermanently());
    }
    await database.batch(...ops);
  });
  await recomputeRoomDenorm(roomId);
}

// ------------------------------------------------------------------
// Core pulls.
// ------------------------------------------------------------------

const PROFILE_COLS =
  "id, display_name, avatar_url, bio, custom_status, is_public, is_online, last_seen_at";

function profileItem(p: any) {
  return {
    id: p.id as string,
    apply: (rec: any) => {
      rec.displayName = p.display_name ?? "Someone";
      rec.avatarUrl = p.avatar_url ?? undefined;
      rec.bio = p.bio ?? undefined;
      rec.customStatus = p.custom_status ?? undefined;
      rec.isPublic = p.is_public ?? true;
      rec.isOnline = p.is_online ?? false;
      rec.lastSeenAt = p.last_seen_at
        ? new Date(p.last_seen_at).getTime()
        : undefined;
    },
  };
}

export async function pullEverything(uid: string): Promise<void> {
  // A request that arrives mid-pull is remembered and replayed, not lost.
  if (syncing) {
    resyncQueued = true;
    return;
  }
  syncing = true;
  try {
    await pullOnce(uid);
  } finally {
    syncing = false;
    if (resyncQueued && currentUserId === uid) {
      resyncQueued = false;
      void pullEverything(uid).catch(() => {});
    }
  }
}

async function pullOnce(uid: string): Promise<void> {
  // 0) The public people directory — fetched FIRST and independent of
  // rooms, so a brand-new account (zero rooms) can still find people and
  // start its first chat. (Before, profiles were only pulled for members
  // of rooms you were already in.)
  {
    const { data: dir, error: dirErr } = await supabase
      .from("profiles_public")
      .select(PROFILE_COLS)
      .order("display_name", { ascending: true })
      .limit(1000);
    if (dirErr) {
      console.warn("[sync] directory pull failed:", dirErr.message);
    } else {
      await upsertManyById(profilesCol as any, (dir ?? []).map(profileItem));
    }
  }

  // 1) My rooms.
  const { data: memberships, error: memErr } = await supabase
    .from("room_members")
    .select("room_id")
    .eq("user_id", uid);
  if (memErr) throw memErr;
  const roomIds = (memberships ?? []).map((r: any) => r.room_id as string);
  if (roomIds.length === 0) return;

  // URL length: `.in(...)` with hundreds of UUIDs can exceed the proxy's
  // URL limit, so every room-id filter is chunked.
  const rooms: any[] = [];
  for (const part of chunk(roomIds, 50)) {
    const { data, error } = await supabase
      .from("rooms")
      .select("id, name, is_dm, is_e2ee, created_at")
      .in("id", part);
    if (error) throw error;
    rooms.push(...(data ?? []));
  }

  // 2) Members of those rooms (for DM titles + read ticks).
  const members: any[] = [];
  for (const part of chunk(roomIds, 50)) {
    const { data } = await supabase
      .from("room_members")
      .select("room_id, user_id")
      .in("room_id", part);
    members.push(...(data ?? []));
  }
  const memberIds = [...new Set(members.map((m) => m.user_id as string))];
  // Refresh rosters for read ticks (seen-by-all in groups).
  membersByRoom.clear();
  for (const m of members) {
    let set = membersByRoom.get(m.room_id);
    if (!set) {
      set = new Set();
      membersByRoom.set(m.room_id, set);
    }
    set.add(m.user_id);
  }

  // 3) Public-gated profiles for everyone involved (+ my own row).
  for (const part of chunk(memberIds, 100)) {
    const { data: pubs } = await supabase
      .from("profiles_public")
      .select(PROFILE_COLS)
      .in("id", part);
    await upsertManyById(profilesCol as any, (pubs ?? []).map(profileItem));
  }

  // DM denorm: room_id -> other member.
  const othersByRoom = new Map<string, string>();
  for (const m of members) {
    if (m.user_id !== uid) othersByRoom.set(m.room_id, m.user_id);
  }
  const nameById = new Map<string, string>();
  for (const p of await profilesCol.query().fetch()) {
    nameById.set(p.id, (p as any).displayName);
  }
  await upsertManyById(
    roomsCol as any,
    rooms.map((r) => {
      const otherId = r.is_dm ? othersByRoom.get(r.id) : undefined;
      return {
        id: r.id as string,
        apply: (rec: any) => {
          rec.name = r.name ?? undefined;
          rec.isGroup = !r.is_dm;
          rec.isE2ee = !!r.is_e2ee;
          rec.createdAt = new Date(r.created_at);
          if (rec.unreadCount == null) rec.unreadCount = 0;
          if (otherId) {
            rec.otherUserId = otherId;
            rec.otherUserName = nameById.get(otherId) ?? rec.otherUserName;
          }
        },
      };
    }),
  );

  // 4) Messages: incremental watermark across create/edit/delete
  // timestamps so edits and soft-deletes of old messages land too.
  // The watermark is CAPPED at (pull start - 2 min): a recent edit
  // of an old message must not inflate it past messages created
  // WHILE this pull was running (they would match no .gt clause
  // next time and be skipped forever). The 2-minute overlap also
  // absorbs device/server clock skew; re-applied rows are
  // idempotent.
  const pullStartedAt = Date.now();
  const lastPull = Number((await AsyncStorage.getItem(lastPullKey(uid))) ?? 0);
  const sinceIso = new Date(lastPull).toISOString();
  let maxSeen = lastPull;
  const PAGE = 500;
  for (const roomPart of chunk(roomIds, 40)) {
    for (let from = 0; ; from += PAGE) {
      const { data: msgs, error: msgErr } = await supabase
        .from("messages")
        .select(
          "id, room_id, user_id, body, type, attachment_url, attachment_meta, created_at, edited_at, deleted_at",
        )
        .in("room_id", roomPart)
        .or(
          `created_at.gt.${sinceIso},edited_at.gt.${sinceIso},deleted_at.gt.${sinceIso}`,
        )
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (msgErr) throw msgErr;
      if (!msgs || msgs.length === 0) break;
      // countUnread=false: unread is derived from receipts afterwards.
      await applyServerMessages(msgs as ServerMessage[], false);
      for (const m of msgs as ServerMessage[]) {
        maxSeen = Math.max(
          maxSeen,
          new Date(m.created_at).getTime(),
          m.edited_at ? new Date(m.edited_at).getTime() : 0,
          m.deleted_at ? new Date(m.deleted_at).getTime() : 0,
        );
      }
      if (msgs.length < PAGE) break;
    }
  }
  const cappedWm = Math.max(lastPull, Math.min(maxSeen, pullStartedAt - 120_000));
  await AsyncStorage.setItem(lastPullKey(uid), String(cappedWm));

  // 5) Receipts for ticks, then the unread badges derived from them.
  const receiptsOk = await pullReceipts(roomIds);
  if (receiptsOk) await recomputeUnread(roomIds, uid);
}

// ------------------------------------------------------------------
// Outbox.
// ------------------------------------------------------------------

async function markFailed(msg: any) {
  try {
    await database.write(async () => {
      await msg.update((r: any) => {
        r.status = "failed";
      });
    });
  } catch {
    /* record was deleted meanwhile */
  }
}

// One flush at a time: concurrent flushes (send + NetInfo + AppState)
// used to pick up the same pending rows and upload attachments twice.
let pushChain: Promise<void> = Promise.resolve();

export function pushPending(uid: string): Promise<void> {
  const run = pushChain
    .then(() => pushPendingInner(uid))
    .catch((e) => {
      console.warn("[push] flush failed:", e?.message ?? e);
    });
  pushChain = run;
  return run;
}

async function pushPendingInner(uid: string): Promise<void> {
  const net = await NetInfo.fetch();
  if (net.isConnected === false) return; // stay pending, retry on reconnect
  const pending = (await messagesCol
    .query(Q.where("status", "pending"), Q.sortBy("created_at", Q.asc))
    .fetch()) as any[];
  for (const msg of pending) {
    let keepGoing = true;
    try {
      keepGoing = await pushOne(uid, msg);
    } catch (e: any) {
      if (isTransientError(e)) break; // network: leave pending, keep order
      console.warn("[push] message failed:", e?.message ?? e);
      await markFailed(msg);
    }
    if (!keepGoing) break;
  }
}

/** @returns false when the network is the problem (stop the flush). */
async function pushOne(uid: string, msg: any): Promise<boolean> {
  // The user may have deleted / already-synced it since the query ran.
  const fresh: any = await messagesCol.find(msg.id).catch(() => null);
  if (!fresh || fresh.status !== "pending") return true;
  msg = fresh;

  const room: any = await roomsCol.find(msg.roomId).catch(() => null);
  let wireBody: string = msg.body;
  if (room?.isE2ee) {
    // E2EE rooms reject plaintext server-side. Text is encrypted
    // here, at the wire boundary — the local copy stays plaintext
    // (device-local trust boundary, like the web's in-memory
    // plaintext). Attachments are not encrypted on the web either
    // and are rejected there, so they fail here too.
    if (!e2eeHooks || msg.msgType !== "text") {
      await markFailed(msg);
      return true;
    }
    try {
      wireBody = await e2eeHooks.encryptForRoom(msg.roomId, msg.body, uid);
    } catch (e: any) {
      if (isTransientError(e)) return false;
      await markFailed(msg);
      return true;
    }
  }
  // Media messages upload their file first; the storage path is
  // persisted locally so a retry never uploads twice (the server
  // also has a unique index on attachment_url).
  let attachmentUrl: string | undefined = msg.attachmentUrl ?? undefined;
  if (!attachmentUrl && msg.msgType !== "text") {
    const meta0 = parseMeta(msg.attachmentMeta);
    if (meta0.localUri) {
      if (!mediaUploader) return true; // uploader not registered yet
      try {
        const up = await mediaUploader(
          uid,
          msg.roomId,
          meta0.localUri,
          meta0.name ?? "file",
          meta0.mime ?? "application/octet-stream",
        );
        attachmentUrl = up.path;
        await database.write(async () => {
          await msg.update((r: any) => {
            r.attachmentUrl = up.path;
            // The server meta must carry the REAL byte size (the
            // picker's can be 0/missing) — write the uploaded size
            // back so serverMeta() picks it up for the insert.
            const mm = parseMeta(r.attachmentMeta);
            if (up.size) mm.size = up.size;
            r.attachmentMeta = JSON.stringify(mm);
          });
        });
      } catch (e: any) {
        if (isTransientError(e)) return false;
        console.warn("[push] upload failed:", e?.message ?? e);
        await markFailed(msg);
        return true;
      }
    } else {
      // Media message without a local file or a storage path can never
      // be sent — fail it instead of inserting an empty bubble.
      await markFailed(msg);
      return true;
    }
  }
  const insert: Record<string, unknown> = {
    id: msg.id,
    room_id: msg.roomId,
    user_id: uid,
    body: wireBody,
    type: msg.msgType ?? "text",
  };
  if (attachmentUrl) insert.attachment_url = attachmentUrl;
  if (msg.attachmentMeta) {
    insert.attachment_meta = serverMeta(msg.attachmentMeta);
  }
  const { error } = await supabase.from("messages").insert(insert);
  const code = (error as any)?.code;
  // 23505 = already there (an earlier attempt landed) — synced.
  const ok = !error || code === "23505";
  if (!ok && isTransientError(error)) return false; // offline: stay pending
  try {
    await database.write(async () => {
      await msg.update((r: any) => {
        r.status = ok ? "synced" : "failed";
      });
    });
  } catch {
    /* deleted while sending */
  }
  return true;
}

// Media upload hook (registered by lib/media at app start) so the
// sync engine can upload pending attachments without importing the
// media module (which itself imports pushPending — no cycles).
let mediaUploader: ((
  uid: string,
  roomId: string,
  localUri: string,
  fileName: string,
  mime: string,
) => Promise<{ path: string; size: number }>) | null = null;
export function registerMediaUploader(
  fn: NonNullable<typeof mediaUploader>,
) {
  mediaUploader = fn;
}

// E2EE hooks (registered by lib/e2ee at app start). Sending into
// encrypted rooms stays fail-closed until the module is loaded.
type E2eeHooks = {
  encryptForRoom: (
    roomId: string,
    plaintext: string,
    uid: string,
  ) => Promise<string>;
  decryptBody: (
    body: string | null | undefined,
    uid: string,
    opts: { roomId: string; senderId: string },
  ) => Promise<string | null>;
  hasWrappedKey: (body: string, uid: string) => boolean;
  isCorrupt: (body: string) => boolean;
};
let e2eeHooks: E2eeHooks | null = null;
export function registerE2eeHooks(hooks: E2eeHooks) {
  e2eeHooks = hooks;
}

async function createLocalMessage(
  uid: string,
  roomId: string,
  fields: { body: string; type: string },
  preview: string,
): Promise<void> {
  const id = uuidv4();
  const now = Date.now();
  await database.write(async () => {
    await messagesCol.create((rec: any) => {
      rec._raw.id = id;
      rec.roomId = roomId;
      rec.senderId = uid;
      rec.body = fields.body;
      rec.msgType = fields.type;
      rec.createdAt = new Date(now);
      rec.status = "pending";
    });
    try {
      const room: any = await roomsCol.find(roomId);
      await room.update((r: any) => {
        r.lastMessageBody = preview;
        r.lastMessageAt = now;
        r.lastSenderId = uid;
      });
    } catch {
      /* room not mirrored yet - the message itself is still queued */
    }
  });
  void pushPending(uid);
}

export async function sendText(
  uid: string,
  roomId: string,
  body: string,
): Promise<void> {
  await createLocalMessage(uid, roomId, { body, type: "text" }, body);
}

/** WhatsApp-style call entry in the chat thread (caller posts it;
 *  body JSON uses the server's wire shape { call, status, duration }). */
export async function sendCallMessage(
  uid: string,
  roomId: string,
  info: {
    type: "voice" | "video";
    status: "completed" | "missed" | "declined" | "failed" | "cancelled";
    duration: number;
  },
): Promise<void> {
  const body = JSON.stringify({
    call: info.type,
    status: info.status,
    duration: info.duration,
  });
  await createLocalMessage(
    uid,
    roomId,
    { body, type: "call" },
    previewFor("call", body),
  );
}

// ------------------------------------------------------------------
// Realtime.
// ------------------------------------------------------------------

async function catchUp(uid: string) {
  await pushPending(uid);
  await pullEverything(uid).catch((e) =>
    console.warn("[sync] catch-up failed:", e?.message ?? e),
  );
  if (currentUserId === uid) await pushPending(uid);
}

export function startRealtime(uid: string) {
  stopRealtime();
  let wasDown = false;
  const ch = supabase
    .channel("rn-messages")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      (payload) => {
        void applyServerMessage(payload.new as ServerMessage, true);
      },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "messages" },
      (payload) => {
        void applyServerMessage(payload.new as ServerMessage, false);
      },
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "messages" },
      (payload) => {
        const id = (payload.old as any)?.id as string | undefined;
        if (id) void applyServerDelete(id);
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "message_reactions" },
      (payload) => {
        void applyReaction(payload.new as ServerReaction);
      },
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "message_reactions" },
      (payload) => {
        void removeReaction(payload.old as Partial<ServerReaction>);
      },
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "typing_status" },
      (payload) => {
        const row: any =
          payload.eventType === "DELETE" ? payload.old : payload.new;
        if (row?.room_id && row?.user_id) {
          applyTyping(
            row.room_id,
            row.user_id,
            payload.eventType !== "DELETE",
          );
        }
      },
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "read_receipts" },
      (payload) => {
        const row: any =
          payload.eventType === "DELETE" ? payload.old : payload.new;
        if (row?.room_id && row?.user_id && row?.last_read_at) {
          setReceipt(
            row.room_id,
            row.user_id,
            new Date(row.last_read_at).getTime(),
          );
        }
      },
    );
  channel = ch;
  ch.subscribe((status) => {
    if (channel !== ch) return; // a newer channel replaced this one
    if (status === "SUBSCRIBED") {
      // Events that happened while the socket was down are gone —
      // fetch what we missed.
      if (wasDown) {
        wasDown = false;
        if (currentUserId) void catchUp(currentUserId);
      }
    } else if (
      status === "CHANNEL_ERROR" ||
      status === "TIMED_OUT" ||
      status === "CLOSED"
    ) {
      wasDown = true;
    }
  });

  // New chats (someone added me to a room) on their OWN channel: if the
  // table isn't in the realtime publication this must not break the
  // message channel above. A message for an unknown room also triggers
  // a resync (see applyServerMessages), so this is a best-effort extra.
  roomsChannel = supabase
    .channel("rn-rooms")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "room_members",
        filter: `user_id=eq.${uid}`,
      },
      () => requestResync(),
    )
    .subscribe();
}

export function stopRealtime() {
  if (channel) {
    void supabase.removeChannel(channel);
    channel = null;
  }
  if (roomsChannel) {
    void supabase.removeChannel(roomsChannel);
    roomsChannel = null;
  }
}

export function startSync(uid: string) {
  currentUserId = uid;
  startRealtime(uid);
  // Never leave the outbox un-flushed because the first pull failed
  // (offline start): flush in `finally`, and retry periodically.
  void pullEverything(uid)
    .catch((e) => console.warn("[sync] initial pull failed:", e?.message ?? e))
    .finally(() => {
      if (currentUserId === uid) void pushPending(uid);
    });
  if (outboxTimer) clearInterval(outboxTimer);
  outboxTimer = setInterval(() => {
    if (currentUserId && AppState.currentState === "active") {
      void pushPending(currentUserId);
    }
  }, 30_000);
}

export function stopSync() {
  currentUserId = null;
  openRoomId = null;
  stopRealtime();
  if (outboxTimer) {
    clearInterval(outboxTimer);
    outboxTimer = null;
  }
  if (resyncTimer) {
    clearTimeout(resyncTimer);
    resyncTimer = null;
  }
}

/** Sign-out cleanup: the local DB is wiped, so the pull watermark and
 *  all in-memory ephemeral state must go with it - otherwise the next
 *  login would only fetch NEW messages into an empty database. */
export async function clearSyncState(uid: string | null): Promise<void> {
  if (uid) await AsyncStorage.removeItem(lastPullKey(uid));
  receiptsByRoom.clear();
  membersByRoom.clear();
  typingByRoom.clear();
  lastTypingSent.clear();
  lastReconcile.clear();
  resyncQueued = false;
  notifyEphemeral();
}

// Flush the outbox + pull fresh data whenever connectivity returns.
let lastNetUp: boolean | null = null;
NetInfo.addEventListener((state) => {
  const up = !!state.isConnected;
  const justCameUp = up && lastNetUp !== true;
  lastNetUp = up;
  if (justCameUp && currentUserId) void catchUp(currentUserId);
});

// Back from the background: the websocket is usually dead by now.
// Re-open it if needed and catch up on anything missed meanwhile.
let lastForegroundCatchUp = 0;
AppState.addEventListener("change", (state) => {
  if (state !== "active" || !currentUserId) return;
  const uid = currentUserId;
  const st = (channel as any)?.state as string | undefined;
  if (!channel || (st && st !== "joined" && st !== "joining")) {
    startRealtime(uid);
  }
  const now = Date.now();
  if (now - lastForegroundCatchUp < 10_000) return;
  lastForegroundCatchUp = now;
  void catchUp(uid);
  if (openRoomId) void markRoomRead(openRoomId);
});
