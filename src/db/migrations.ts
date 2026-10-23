import {
  schemaMigrations,
  createTable,
  addColumns,
} from "@nozbe/watermelondb/Schema/migrations";

// v2: message edit/delete timestamps + attachment meta + reactions.
export const migrations = schemaMigrations({
  migrations: [
    {
      toVersion: 2,
      steps: [
        addColumns({
          table: "messages",
          columns: [
            { name: "attachment_meta", type: "string", isOptional: true },
            { name: "edited_at", type: "number", isOptional: true },
            { name: "deleted_at", type: "number", isOptional: true },
          ],
        }),
        createTable({
          name: "reactions",
          columns: [
            { name: "message_id", type: "string", isIndexed: true },
            { name: "user_id", type: "string" },
            { name: "emoji", type: "string" },
          ],
        }),
      ],
    },
  ],
});
