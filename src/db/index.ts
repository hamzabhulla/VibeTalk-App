import { Database, Q } from "@nozbe/watermelondb";
import SQLiteAdapter from "@nozbe/watermelondb/adapters/sqlite";
import { schema } from "./schema";
import { migrations } from "./migrations";
import { Profile, Room, Message, Reaction } from "./models";

const adapter = new SQLiteAdapter({
  schema,
  migrations,
  dbName: "vibetalk",
  // JSI DISABLED (v1.0.13 diagnostic): jsi:true ran at import time and
  // threw when the JSI bindings weren't installed yet — top-level throw
  // in release = instant crash before React mounts. Async bridge mode
  // is reliable; the perf difference is negligible for a chat app.
  jsi: false,
  onSetUpError: (error) => {
    // Surfaced in dev; a corrupt local DB self-heals by reset in the
    // sync layer (worst case the user re-syncs from the server).
    console.error("[db] setup error", error);
  },
});

export const database = new Database({
  adapter,
  modelClasses: [Profile, Room, Message, Reaction],
});

export const profilesCol = database.get<Profile>("profiles");
export const roomsCol = database.get<Room>("rooms");
export const messagesCol = database.get<Message>("messages");
export const reactionsCol = database.get<Reaction>("reactions");

export type UpsertItem = { id: string; apply: (rec: any) => void };

// Upsert many rows by server id in ONE writer transaction + ONE batch.
// Watermelon record ids ARE the server UUIDs, so a fetched row either
// updates the local copy or creates it with that exact id (via _raw.id).
// Because the existence check happens INSIDE the writer, two concurrent
// callers (realtime + pull) can no longer both decide "create" for the
// same id and hit a UNIQUE constraint error. Duplicate ids inside one
// call are collapsed (last one wins).
export async function upsertManyById(
  collection: ReturnType<Database["get"]>,
  items: UpsertItem[],
): Promise<void> {
  if (items.length === 0) return;
  const unique = new Map<string, UpsertItem>();
  for (const it of items) unique.set(it.id, it);
  const list = [...unique.values()];
  await database.write(async () => {
    const CHUNK = 400; // stay well below SQLite's 999 variable limit
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      const existing: any[] = await collection
        .query(Q.where("id", Q.oneOf(chunk.map((c) => c.id))))
        .fetch();
      const byId = new Map<string, any>(existing.map((r) => [r.id, r]));
      const ops = chunk.map((item) => {
        const rec = byId.get(item.id);
        if (rec) return rec.prepareUpdate((r: any) => item.apply(r));
        return (collection as any).prepareCreate((r: any) => {
          r._raw.id = item.id;
          item.apply(r);
        });
      });
      await database.batch(...ops);
    }
  });
}

export async function upsertById(
  collection: ReturnType<Database["get"]>,
  id: string,
  apply: (rec: any) => void,
): Promise<void> {
  await upsertManyById(collection, [{ id, apply }]);
}
