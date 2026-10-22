import { Database } from "@nozbe/watermelondb";
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

// Upsert by server id: Watermelon record ids ARE the server UUIDs, so
// a fetched row either updates the local copy or creates it with that
// exact id (via _raw.id before first save).
export async function upsertById<T extends Profile | Room | Message | Reaction>(
  collection: ReturnType<Database["get"]>,
  id: string,
  apply: (rec: any) => void,
): Promise<void> {
  let existing: any = null;
  try {
    existing = await collection.find(id);
  } catch {
    existing = null;
  }
  await database.write(async () => {
    if (existing) {
      await existing.update((rec: any) => apply(rec));
    } else {
      await collection.create((rec: any) => {
        rec._raw.id = id;
        apply(rec);
      });
    }
  });
}
