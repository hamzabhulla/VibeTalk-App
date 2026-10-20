import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { Q } from "@nozbe/watermelondb";
import { supabase } from "./supabase";
import {
  database,
  profilesCol,
  roomsCol,
  messagesCol,
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

export function setOpenRoom(id: string | null) {
  openRoomId = id;
  if (id) void markRoomRead(id);
}

function lastPullKey(uid: string) {
  return `vt-last-pull-${uid}`;
}

type ServerMessage = {
  id: string;
  room_id: string;
  sender_id: string;
  body: string | null;
  type: string;
  attachment_url: string | null;
  created_at: string;
};

async function applyServerMessage(m: ServerMessage, countUnread: boolean) {
  const createdMs = new Date(m.created_at).getTime();
  await upsertById(messagesCol as any, m.id, (rec: any) => {
    rec.roomId = m.room_id;
    rec.senderId = m.sender_id;
    rec.body = m.body ?? "";
    rec.msgType = m.type;
    rec.attachmentUrl = m.attachment_url ?? undefined;
    rec.createdAt = new Date(createdMs);
    // Never resurrect a pending local copy's status backwards.
    if (rec.status !== "pending") rec.status = "synced";
  });
  // Room denorm: last message + unread.
  try {
    const room: any = await roomsCol.find(m.room_id);
    await database.write(async () => {
      await room.update((r: any) => {
        if (!r.lastMessageAt || createdMs >= r.lastMessageAt) {
          r.lastMessageBody =
            m.type === "text" ? (m.body ?? "") : `[${m.type}]`;
          r.lastMessageAt = createdMs;
          r.lastSenderId = m.sender_id;
        }
        if (
          countUnread &&
          m.sender_id !== currentUserId &&
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
}

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
      .select("id, name, is_group, is_e2ee, created_at")
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
      const otherId = (r as any).is_group
        ? undefined
        : othersByRoom.get((r as any).id);
      await upsertById(roomsCol as any, (r as any).id, (rec: any) => {
        rec.name = (r as any).name ?? undefined;
        rec.isGroup = !!(r as any).is_group;
        rec.isE2ee = !!(r as any).is_e2ee;
        rec.createdAt = new Date((r as any).created_at);
        if (rec.unreadCount == null) rec.unreadCount = 0;
        if (otherId) {
          rec.otherUserId = otherId;
          rec.otherUserName = nameById.get(otherId) ?? rec.otherUserName;
        }
      });
    }

    // 4) Messages: incremental by created_at watermark.
    const lastPull = Number(
      (await AsyncStorage.getItem(lastPullKey(uid))) ?? 0,
    );
    const sinceIso = new Date(lastPull).toISOString();
    let maxSeen = lastPull;
    const PAGE = 500;
    for (let from = 0; ; from += PAGE) {
      const { data: msgs, error: msgErr } = await supabase
        .from("messages")
        .select("id, room_id, sender_id, body, type, attachment_url, created_at")
        .in("room_id", roomIds)
        .gt("created_at", sinceIso)
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (msgErr) throw msgErr;
      if (!msgs || msgs.length === 0) break;
      for (const m of msgs as ServerMessage[]) {
        await applyServerMessage(m, false);
        maxSeen = Math.max(maxSeen, new Date(m.created_at).getTime());
      }
      if (msgs.length < PAGE) break;
    }
    await AsyncStorage.setItem(lastPullKey(uid), String(maxSeen));
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
    if (room?.isE2ee) {
      // E2EE rooms reject plaintext server-side; the RN client does
      // not encrypt yet (next milestone) — fail loudly, never send
      // a plaintext body into an encrypted room.
      await database.write(async () => {
        await msg.update((r: any) => {
          r.status = "failed";
        });
      });
      continue;
    }
    const { error } = await supabase.from("messages").insert({
      id: msg.id,
      room_id: msg.roomId,
      sender_id: uid,
      body: msg.body,
      type: "text",
    });
    await database.write(async () => {
      await msg.update((r: any) => {
        // 23505 = already there (an earlier attempt landed) — synced.
        r.status = !error || (error as any).code === "23505" ? "synced" : "failed";
      });
    });
  }
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
