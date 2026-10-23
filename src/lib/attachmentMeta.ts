// Pure helpers for the attachment_meta JSON (no imports — shared by
// the sync engine and the media module without a dependency cycle).

export type AttachmentMeta = {
  name?: string;
  size?: number;
  mime?: string;
  // Local-only keys (never sent to the server):
  localUri?: string;
  w?: number;
  h?: number;
  durationMs?: number;
};

export function parseMeta(raw?: string | null): AttachmentMeta {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** The exact meta shape the server contract allows: {name,size,mime}. */
export function serverMeta(raw?: string | null): {
  name?: string;
  size?: number;
  mime?: string;
} {
  const m = parseMeta(raw);
  const out: { name?: string; size?: number; mime?: string } = {};
  if (m.name) out.name = m.name;
  if (typeof m.size === "number") out.size = m.size;
  if (m.mime) out.mime = m.mime;
  return out;
}
