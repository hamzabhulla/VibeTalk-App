import { appSchema, tableSchema } from "@nozbe/watermelondb";

// Local mirror of the Supabase tables the app reads (profiles_public
// shape for people, rooms + messages for chats), plus local-only sync
// state on messages (status) and rooms (unread_count, DM denorm).
export const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: "profiles",
      columns: [
        { name: "display_name", type: "string" },
        { name: "avatar_url", type: "string", isOptional: true },
        { name: "bio", type: "string", isOptional: true },
        { name: "custom_status", type: "string", isOptional: true },
        { name: "is_public", type: "boolean" },
        { name: "is_online", type: "boolean", isOptional: true },
        { name: "last_seen_at", type: "number", isOptional: true },
      ],
    }),
    tableSchema({
      name: "rooms",
      columns: [
        { name: "name", type: "string", isOptional: true },
        { name: "is_group", type: "boolean" },
        { name: "is_e2ee", type: "boolean" },
        { name: "created_at", type: "number" },
        { name: "last_message_body", type: "string", isOptional: true },
        { name: "last_message_at", type: "number", isOptional: true },
        { name: "last_sender_id", type: "string", isOptional: true },
        { name: "unread_count", type: "number" },
        // DM denormalization for list rendering without joins.
        { name: "other_user_id", type: "string", isOptional: true },
        { name: "other_user_name", type: "string", isOptional: true },
      ],
    }),
    tableSchema({
      name: "messages",
      columns: [
        { name: "room_id", type: "string", isIndexed: true },
        { name: "sender_id", type: "string" },
        { name: "body", type: "string" },
        { name: "msg_type", type: "string" },
        { name: "attachment_url", type: "string", isOptional: true },
        { name: "created_at", type: "number" },
        // local-only: 'synced' | 'pending' | 'failed'
        { name: "status", type: "string" },
      ],
    }),
  ],
});
