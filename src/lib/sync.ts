import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { Q } from "@nozbe/watermelondb";
import { supabase } from "./supabase";
import { parseMeta, serverMeta } from "./attachmentMeta";
import {
  database,
  profilesCol,
  roomsCol,
  messagesCol,
  reactionsCol,
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
let syncing = false;

// Server policy (messages_update_own_recent): a message may only be
// edited or deleted within 5 minutes of sending. The UI mirrors it.
export const EDIT_WINDOW_MS = 5 * 60 * 1000;

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

async function applyServerMessage(m: ServerMessage, countUnread: boolean) {
  const createdMs = new Date(m.created_at).getTime();
  if (m.deleted_at) {
    // Web hides soft-deleted messages entirely — mirror that: the
    // local copy is destroyed and the room preview recomputed.
    try {
      const local: any = await messagesCol.find(m.id);
      await database.write(async () => {
        await local.destroyPermanently();
      });
    } catch {
      /* not mirrored */
    }
    await recomputeRoomDenorm(m.room_id);
    return;
  }
  // E2EE: decrypt at the boundary — the device DB stores plaintext
  // (or the web's exact placeholders when decryption is impossible).
  let displayBody = m.body ?? "";
  let roomIsE2ee = false;
  try {
    const r: any = await roomsCol.find(m.room_id);
    roomIsE2ee = !!r.isE2ee;
  } catch {
    /* room not mirrored yet */
  }
  if (roomIsE2ee && m.body?.startsWith("E2E1:") && currentUserId) {
    let localExisting: any = null;
    try {
      localExisting = await messagesCol.find(m.id);
    } catch {
      /* not local */
    }
    if (
      localExisting?.status === "pending" &&
      localExisting.senderId === currentUserId
    ) {
      // My own outbox echo: keep the local plaintext copy.
      displayBody = localExisting.body;
    } else if (e2eeHooks) {
      const pt = await e2eeHooks.decryptBody(m.body, currentUserId, {
        roomId: m.room_id,
        senderId: m.user_id,
      });
      displayBody =
        pt ??
        (e2eeHooks.isCorrupt(m.body) ||
        e2eeHooks.hasWrappedKey(m.body, currentUserId)
          ? "Couldn't decrypt this message"
          : "🔒 Sent before you joined");
    } else {
      displayBody = "🔒 Encrypted message";
    }
  }
  await upsertById(messagesCol as any, m.id, (rec: any) => {
    rec.roomId = m.room_id;
    rec.senderId = m.user_id;
    rec.body = displayBody;
    rec.msgType = m.type;
    rec.attachmentUrl = m.attachment_url ?? undefined;
    // Merge, never overwrite: the server meta is only {name,size,
    // mime}; the local-only keys (w/h/durationMs, plus localUri
    // until the upload lands) live solely in the local copy — a
    // plain overwrite made own voice notes lose their duration and
    // images their dimensions on the echo.
    if (m.attachment_meta) {
      const prev = parseMeta(rec.attachmentMeta);
      const merged: Record<string, unknown> = {
        ...(m.attachment_meta as Record<string, unknown>),
      };
      if (prev.w) merged.w = prev.w;
      if (prev.h) merged.h = prev.h;
      if (prev.durationMs) merged.durationMs = prev.durationMs;
      if (prev.localUri && !m.attachment_url) merged.localUri = prev.localUri;
      rec.attachmentMeta = JSON.stringify(merged);
    } else {
      rec.attachmentMeta = undefined;
    }
    rec.createdAt = new Date(createdMs);
    rec.editedAt = m.edited_at
      ? new Date(m.edited_at).getTime()
      : undefined;
    rec.deletedAt = undefined;
    // Never resurrect a pending local copy's status backwards.
    if (rec.status !== "pending") rec.status = "synced";
  });
  // Room denorm: last message + unread.
  try {
    const room: any = await roomsCol.find(m.room_id);
    await database.write(async () => {
      await room.update((r: any) => {
        if (!r.lastMessageAt || createdMs >= r.lastMessageAt) {
          r.lastMessageBody = roomIsE2ee
            ? "🔒 Encrypted message"
            : previewFor(m.type, m.body);
          r.lastMessageAt = createdMs;
          r.lastSenderId = m.user_id;
        }
        if (
          countUnread &&
          m.user_id !== currentUserId &&
          openRoomId !== m.room_id
        ) {
          r.unreadCount = (r.unreadCount ?? 0) + 1;
        }
      });
    });
  } catch {
    // Room not mirrored yet — the next pull will create it.
  }
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
  if (currentUserId) {
    const nowIso = new Date().toISOString();
    await supabase
      .from("read_receipts")
      .upsert(
        { room_id: roomId, user_id: currentUserId, last_read_at: nowIso },
        { onConflict: "room_id,user_id" },
      )
      .then(({ error }) => {
        if (error) console.warn("[receipts] mark read failed:", error.message);
      });
    setReceipt(roomId, currentUserId, Date.now());
  }
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

export async function pullReceipts(roomIds: string[]) {
  if (!roomIds.length) return;
  const { data, error } = await supabase
    .from("read_receipts")
    .select("room_id, user_id, last_read_at")
    .in("room_id", roomIds);
  if (error) {
    console.warn("[receipts] pull failed:", error.message);
    return;
  }
  for (const r of data ?? []) {
    setReceipt(
      (r as any).room_id,
      (r as any).user_id,
      new Date((r as any).last_read_at).getTime(),
    );
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

async function applyReaction(row: ServerReaction) {
  await upsertById(
    reactionsCol as any,
    reactionId(row.message_id, row.user_id, row.emoji),
    (rec: any) => {
      rec.messageId = row.message_id;
      rec.userId = row.user_id;
      rec.emoji = row.emoji;
    },
  );
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
  const msgs = await messagesCol
    .query(Q.where("room_id", roomId))
    .fetch();
  const ids = msgs.map((m) => m.id);
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const { data, error } = await supabase
      .from("message_reactions")
      .select("message_id, user_id, emoji")
      .in("message_id", chunk);
    if (error) {
      console.warn("[reactions] pull failed:", error.message);
      return;
    }
    // Replace semantics for these messages: drop local rows the
    // server no longer has (toggles that happened elsewhere).
    const serverKeys = new Set(
      (data ?? []).map((r: any) =>
        reactionId(r.message_id, r.user_id, r.emoji),
      ),
    );
    const local = await reactionsCol
      .query(Q.where("message_id", Q.oneOf(chunk)))
      .fetch();
    await database.write(async () => {
      for (const lr of local as any[]) {
        if (!serverKeys.has(lr.id)) await lr.destroyPermanently();
      }
    });
    for (const r of (data ?? []) as ServerReaction[]) await applyReaction(r);
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
export async function reconcileRoomDeletes(roomId: string): Promise<void> {
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
  const locals = await messagesCol
    .query(Q.where("room_id", roomId), Q.where("status", "synced"))
    .fetch();
  const gone = locals.filter((m: any) => !serverIds.has(m.id));
  if (gone.length === 0) return;
  const goneIds = new Set(gone.map((m: any) => m.id as string));
  await database.write(async () => {
    for (const m of gone) await m.destroyPermanently();
    // Their reactions are cascade-gone server-side too — don't
    // leave orphan rows behind locally. (The local reactions table
    // is keyed by message_id only — it has no room_id column.)
    const orphans = await reactionsCol
      .query(Q.where("message_id", Q.oneOf([...goneIds])))
      .fetch();
    for (const r of orphans as any[]) {
      await r.destroyPermanently();
    }
  });
  await recomputeRoomDenorm(roomId);
}

// ------------------------------------------------------------------
// Core pulls.
// ------------------------------------------------------------------

export async function pullEverything(uid: string): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    // 1) My rooms.
    const { data: memberships, error: memErr } = await supabase
      .from("room_members")
      .select("room_id")
      .eq("user_id", uid);
    if (memErr) throw memErr;
    const roomIds = (memberships ?? []).map((r: any) => r.room_id as string);
    if (roomIds.length === 0) return;

    const { data: rooms, error: roomErr } = await supabase
      .from("rooms")
      .select("id, name, is_dm, is_e2ee, created_at")
      .in("id", roomIds);
    if (roomErr) throw roomErr;

    // 2) Members of those rooms (for DM titles + People).
    const { data: members } = await supabase
      .from("room_members")
      .select("room_id, user_id")
      .in("room_id", roomIds);
    const memberIds = [
      ...new Set((members ?? []).map((m: any) => m.user_id as string)),
    ];
    // Refresh rosters for read ticks (seen-by-all in groups).
    membersByRoom.clear();
    for (const m of members ?? []) {
      let set = membersByRoom.get((m as any).room_id);
      if (!set) {
        set = new Set();
        membersByRoom.set((m as any).room_id, set);
      }
      set.add((m as any).user_id);
    }

    // 3) Public-gated profiles for everyone involved (+ my own row).
    if (memberIds.length) {
      const { data: pubs } = await supabase
        .from("profiles_public")
        .select(
          "id, display_name, avatar_url, bio, custom_status, is_public, is_online, last_seen_at",
        )
        .in("id", memberIds);
      for (const p of pubs ?? []) {
        await upsertById(profilesCol as any, p.id, (rec: any) => {
          rec.displayName = p.display_name ?? "Someone";
          rec.avatarUrl = p.avatar_url ?? undefined;
          rec.bio = p.bio ?? undefined;
          rec.customStatus = p.custom_status ?? undefined;
          rec.isPublic = p.is_public ?? true;
          rec.isOnline = p.is_online ?? false;
          rec.lastSeenAt = p.last_seen_at
            ? new Date(p.last_seen_at).getTime()
            : undefined;
        });
      }
    }

    // DM denorm: room_id -> other member.
    const othersByRoom = new Map<string, string>();
    for (const m of members ?? []) {
      if (m.user_id !== uid) othersByRoom.set(m.room_id, m.user_id);
    }
    const nameById = new Map<string, string>();
    const localProfiles = await profilesCol.query().fetch();
    for (const p of localProfiles) nameById.set(p.id, (p as any).displayName);

    for (const r of rooms ?? []) {
      const otherId = (r as any).is_dm
        ? othersByRoom.get((r as any).id)
        : undefined;
      await upsertById(roomsCol as any, (r as any).id, (rec: any) => {
        rec.name = (r as any).name ?? undefined;
        rec.isGroup = !(r as any).is_dm;
        rec.isE2ee = !!(r as any).is_e2ee;
        rec.createdAt = new Date((r as any).created_at);
        if (rec.unreadCount == null) rec.unreadCount = 0;
        if (otherId) {
          rec.otherUserId = otherId;
          rec.otherUserName = nameById.get(otherId) ?? rec.otherUserName;
        }
      });
    }

    // 4) Messages: incremental watermark across create/edit/delete
    // timestamps so edits and soft-deletes of old messages land too.
    // The watermark is CAPPED at (pull start - 2 min): a recent edit
    // of an old message must not inflate it past messages created
    // WHILE this pull was running (they would match no .gt clause
    // next time and be skipped forever). The 2-minute overlap also
    // absorbs device/server clock skew; re-applied rows are
    // idempotent.
    const pullStartedAt = Date.now();
    const lastPull = Number(
      (await AsyncStorage.getItem(lastPullKey(uid))) ?? 0,
    );
    const sinceIso = new Date(lastPull).toISOString();
    let maxSeen = lastPull;
    const PAGE = 500;
    for (let from = 0; ; from += PAGE) {
      const { data: msgs, error: msgErr } = await supabase
        .from("messages")
        .select(
          "id, room_id, user_id, body, type, attachment_url, attachment_meta, created_at, edited_at, deleted_at",
        )
        .in("room_id", roomIds)
        .or(
          `created_at.gt.${sinceIso},edited_at.gt.${sinceIso},deleted_at.gt.${sinceIso}`,
        )
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (msgErr) throw msgErr;
      if (!msgs || msgs.length === 0) break;
      for (const m of msgs as ServerMessage[]) {
        await applyServerMessage(m, false);
        maxSeen = Math.max(
          maxSeen,
          new Date(m.created_at).getTime(),
          m.edited_at ? new Date(m.edited_at).getTime() : 0,
          m.deleted_at ? new Date(m.deleted_at).getTime() : 0,
        );
      }
      if (msgs.length < PAGE) break;
    }
    const cappedWm = Math.max(
      lastPull,
      Math.min(maxSeen, pullStartedAt - 120_000),
    );
    await AsyncStorage.setItem(lastPullKey(uid), String(cappedWm));

    // 5) Receipts for ticks.
    await pullReceipts(roomIds);
  } finally {
    syncing = false;
  }
}

export async function pushPending(uid: string): Promise<void> {
  const pending = await messagesCol
    .query(Q.where("status", "pending"))
    .fetch();
  for (const msg of pending as any[]) {
    const room: any = await roomsCol.find(msg.roomId).catch(() => null);
    let wireBody: string = msg.body;
    if (room?.isE2ee) {
      // E2EE rooms reject plaintext server-side. Text is encrypted
      // here, at the wire boundary — the local copy stays plaintext
      // (device-local trust boundary, like the web's in-memory
      // plaintext). Attachments are not encrypted on the web either
      // and are rejected there, so they fail here too.
      if (!e2eeHooks || msg.msgType !== "text") {
        await database.write(async () => {
          await msg.update((r: any) => {
            r.status = "failed";
          });
        });
        continue;
      }
      try {
        wireBody = await e2eeHooks.encryptForRoom(msg.roomId, msg.body, uid);
      } catch {
        await database.write(async () => {
          await msg.update((r: any) => {
            r.status = "failed";
          });
        });
        continue;
      }
    }
    // Media messages upload their file first; the storage path is
    // persisted locally so a retry never uploads twice (the server
    // also has a unique index on attachment_url).
    let attachmentUrl: string | undefined = msg.attachmentUrl ?? undefined;
    if (!attachmentUrl && msg.msgType !== "text") {
      const meta0 = parseMeta(msg.attachmentMeta);
      if (meta0.localUri) {
        if (!mediaUploader) continue; // uploader not registered yet
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
              mm.size = up.size;
              r.attachmentMeta = JSON.stringify(mm);
            });
          });
        } catch {
          await database.write(async () => {
            await msg.update((r: any) => {
              r.status = "failed";
            });
          });
          continue;
        }
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
    await database.write(async () => {
      await msg.update((r: any) => {
        // 23505 = already there (an earlier attempt landed) — synced.
        r.status = !error || (error as any).code === "23505" ? "synced" : "failed";
      });
    });
  }
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

export async function sendText(
  uid: string,
  roomId: string,
  body: string,
): Promise<void> {
  const id = globalThis.crypto.randomUUID();
  const now = Date.now();
  await database.write(async () => {
    await messagesCol.create((rec: any) => {
      rec._raw.id = id;
      rec.roomId = roomId;
      rec.senderId = uid;
      rec.body = body;
      rec.msgType = "text";
      rec.createdAt = new Date(now);
      rec.status = "pending";
    });
    const room: any = await roomsCol.find(roomId);
    await room.update((r: any) => {
      r.lastMessageBody = body;
      r.lastMessageAt = now;
      r.lastSenderId = uid;
    });
  });
  void pushPending(uid);
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
  const id = globalThis.crypto.randomUUID();
  const now = Date.now();
  const body = JSON.stringify({
    call: info.type,
    status: info.status,
    duration: info.duration,
  });
  await database.write(async () => {
    await messagesCol.create((rec: any) => {
      rec._raw.id = id;
      rec.roomId = roomId;
      rec.senderId = uid;
      rec.body = body;
      rec.msgType = "call";
      rec.createdAt = new Date(now);
      rec.status = "pending";
    });
    try {
      const room: any = await roomsCol.find(roomId);
      await room.update((r: any) => {
        r.lastMessageBody = previewFor("call", body);
        r.lastMessageAt = now;
        r.lastSenderId = uid;
      });
    } catch {
      /* room not mirrored */
    }
  });
  void pushPending(uid);
}

export function startRealtime(uid: string) {
  stopRealtime();
  channel = supabase
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
    )
    .subscribe();
}

export function stopRealtime() {
  if (channel) {
    void supabase.removeChannel(channel);
    channel = null;
  }
}

export function startSync(uid: string) {
  currentUserId = uid;
  void pullEverything(uid).then(() => pushPending(uid));
  startRealtime(uid);
}

export function stopSync() {
  currentUserId = null;
  stopRealtime();
}

// Flush the outbox + pull fresh data whenever connectivity returns.
NetInfo.addEventListener((state) => {
  if (state.isConnected && currentUserId) {
    void pushPending(currentUserId).then(() =>
      pullEverything(currentUserId!),
    );
  }
});
