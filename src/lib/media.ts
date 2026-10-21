import { launchImageLibrary } from "react-native-image-picker";
import { supabase } from "./supabase";
import { database, messagesCol, roomsCol } from "../db";
import { pushPending, registerMediaUploader } from "./sync";

export { parseMeta, serverMeta } from "./attachmentMeta";

// Attachments mirror the web contract exactly:
//  - bucket "chat-attachments", path "<userId>/<roomId>/<uuid>-<name>"
//  - message type from the mime prefix (image/video/audio/file)
//  - attachment_meta on the server is { name, size, mime } only —
//    local-only keys (localUri, w, h, durationMs) never leave the
//    device; pushPending strips them before insert.

export type PickedImage = {
  uri: string;
  fileName: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
};

export function typeForMime(mime: string): "image" | "video" | "audio" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

export async function pickImage(): Promise<PickedImage | null> {
  const res = await launchImageLibrary({
    mediaType: "photo",
    selectionLimit: 1,
    quality: 0.9,
  });
  if (res.didCancel || res.errorCode) return null;
  const a = res.assets?.[0];
  if (!a?.uri) return null;
  return {
    uri: a.uri,
    fileName: a.fileName ?? `photo-${Date.now()}.jpg`,
    mime: a.type ?? "image/jpeg",
    size: a.fileSize ?? 0,
    width: a.width,
    height: a.height,
  };
}

function safeName(name: string) {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

export async function uploadAttachment(
  uid: string,
  roomId: string,
  localUri: string,
  fileName: string,
  mime: string,
): Promise<{ path: string; size: number }> {
  const path = `${uid}/${roomId}/${globalThis.crypto.randomUUID()}-${safeName(fileName)}`;
  const buf = await (await fetch(localUri)).arrayBuffer();
  const { error } = await supabase.storage
    .from("chat-attachments")
    .upload(path, buf, { contentType: mime, upsert: false });
  if (error) throw error;
  return { path, size: buf.byteLength };
}

// Signed-URL cache (bucket is private; web signs the same way).
const urlCache = new Map<string, { url: string; exp: number }>();

export async function getSignedUrl(path: string): Promise<string | null> {
  const hit = urlCache.get(path);
  if (hit && hit.exp - Date.now() > 5 * 60 * 1000) return hit.url;
  const { data, error } = await supabase.storage
    .from("chat-attachments")
    .createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 3600 * 1000 });
  return data.signedUrl;
}

/** Local-first media send: bubble appears instantly from the local
 *  file; pushPending uploads + inserts when the network allows. */
export async function sendMediaMessage(
  uid: string,
  roomId: string,
  asset: {
    uri: string;
    fileName: string;
    mime: string;
    size: number;
    width?: number;
    height?: number;
    durationMs?: number;
  },
  caption: string,
): Promise<void> {
  const id = globalThis.crypto.randomUUID();
  const now = Date.now();
  const type = typeForMime(asset.mime);
  const localMeta = JSON.stringify({
    name: asset.fileName,
    size: asset.size,
    mime: asset.mime,
    localUri: asset.uri,
    w: asset.width,
    h: asset.height,
    durationMs: asset.durationMs,
  });
  await database.write(async () => {
    await messagesCol.create((rec: any) => {
      rec._raw.id = id;
      rec.roomId = roomId;
      rec.senderId = uid;
      rec.body = caption;
      rec.msgType = type;
      rec.attachmentMeta = localMeta;
      rec.createdAt = new Date(now);
      rec.status = "pending";
    });
    const room: any = await roomsCol.find(roomId);
    await room.update((r: any) => {
      r.lastMessageBody = caption || `[${type}]`;
      r.lastMessageAt = now;
      r.lastSenderId = uid;
    });
  });
  void pushPending(uid);
}

// The sync engine uploads pending media through this hook (kept as a
// registration so sync.ts never imports this module — no cycle).
registerMediaUploader(uploadAttachment);
