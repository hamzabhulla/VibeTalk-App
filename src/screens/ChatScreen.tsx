import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Image,
  Modal,
} from "react-native";
import { Q } from "@nozbe/watermelondb";
import {
  SendHorizonal,
  Clock,
  TriangleAlert,
  Check,
  CheckCheck,
  X,
  Paperclip,
  File as FileIcon,
  Mic,
  Play,
  Pause,
  Trash2,
} from "lucide-react-native";
import {
  pickImage,
  sendMediaMessage,
  getSignedUrl,
  parseMeta,
} from "../lib/media";
import {
  ensureMicPermission,
  startRecording,
  stopRecording,
  cancelRecording,
  playAudio,
  stopAudio,
  currentPlayingId,
  onPlayStateChange,
  formatDuration,
  knownDuration,
} from "../lib/voice";
import { startCall } from "../lib/calls";

import { Phone, Video } from "lucide-react-native";
import { messagesCol, roomsCol, reactionsCol, profilesCol, database } from "../db";
import type { Message, Reaction } from "../db/models";
import { useObserved, formatBubbleTime } from "../components/hooks";
import { useAuth } from "../lib/auth";
import {
  sendText,
  pushPending,
  setOpenRoom,
  toggleReaction,
  editMessage,
  deleteMessage,
  EDIT_WINDOW_MS,
  setTyping,
  clearTyping,
  typingUsers,
  someoneReadAt,
  onEphemeralChange,
  reconcileRoomDeletes,
  fetchTyping,
} from "../lib/sync";
import { useFocusEffect } from "@react-navigation/native";
import { colors, font } from "../theme";

// Same quick-react set as the web app.
const QUICK_REACT = ["❤️", "😂", "😮", "😢", "👍", "🔥"];

/** Voice note bubble: plays the local file or the signed URL. */
function VoiceNoteBubble({ msg, mine }: { msg: Message; mine: boolean }) {
  const meta = parseMeta(msg.attachmentMeta);
  const [uri, setUri] = useState<string | null>(meta.localUri ?? null);
  const [, setPlayTick] = useState(0);
  useEffect(() => {
    const off = onPlayStateChange(() => setPlayTick((t) => t + 1));
    return off;
  }, []);
  useEffect(() => {
    if (uri || !msg.attachmentUrl) return;
    let alive = true;
    void getSignedUrl(msg.attachmentUrl).then((u) => {
      if (alive) setUri(u);
    });
    return () => {
      alive = false;
    };
  }, [msg.attachmentUrl, meta.localUri]);
  const isPlaying = currentPlayingId() === msg.id;
  return (
    <View style={styles.voiceRow}>
      <TouchableOpacity
        style={[styles.voiceBtn, mine && styles.voiceBtnMine]}
        onPress={() => uri && void playAudio(msg.id, uri)}
        activeOpacity={0.85}
      >
        {isPlaying ? (
          <Pause size={17} color={mine ? colors.bubbleOwn : "#fff"} />
        ) : (
          <Play size={17} color={mine ? colors.bubbleOwn : "#fff"} />
        )}
      </TouchableOpacity>
      <Text style={[styles.voiceDur, mine && styles.bodyMine]}>
        🎤 {formatDuration(meta.durationMs ?? knownDuration(msg.id))}
      </Text>
    </View>
  );
}

/** Chat image: local file while pending, signed URL after upload. */
function MediaImage({
  msg,
  onPress,
}: {
  msg: Message;
  onPress: (url: string) => void;
}) {
  const meta = parseMeta(msg.attachmentMeta);
  const [remote, setRemote] = useState<string | null>(null);
  useEffect(() => {
    if (meta.localUri || !msg.attachmentUrl) return;
    let alive = true;
    void getSignedUrl(msg.attachmentUrl).then((u) => {
      if (alive) setRemote(u);
    });
    return () => {
      alive = false;
    };
  }, [msg.attachmentUrl]);
  const uri = meta.localUri ?? remote;
  const aspect = meta.w && meta.h ? meta.w / meta.h : 4 / 3;
  if (!uri) {
    return (
      <View style={[styles.imgPlaceholder, { aspectRatio: aspect }]}>
        <Text style={styles.imgPlaceholderText}>Loading photo…</Text>
      </View>
    );
  }
  return (
    <TouchableOpacity activeOpacity={0.9} onPress={() => onPress(uri)}>
      <Image
        source={{ uri }}
        style={[styles.chatImage, { aspectRatio: aspect }]}
        resizeMode="cover"
      />
    </TouchableOpacity>
  );
}

export function ChatScreen({ route, navigation }: any) {
  const { roomId } = route.params as { roomId: string };
  const { user } = useAuth();
  const [draft, setDraft] = useState("");
  const [isE2ee, setIsE2ee] = useState(false);
  const [editing, setEditing] = useState<Message | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordMs, setRecordMs] = useState(0);
  const [, setTick] = useState(0);
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const listRef = useRef<FlatList>(null);

  useFocusEffect(
    React.useCallback(() => {
      setOpenRoom(roomId);
      // Heal deletions that happened on other devices while offline.
      void reconcileRoomDeletes(roomId);
      void fetchTyping(roomId);
      return () => {
        setOpenRoom(null);
        void clearTyping(roomId);
        void stopAudio();
      };
    }, [roomId]),
  );

  useEffect(() => {
    roomsCol
      .find(roomId)
      .then((r: any) => {
        setIsE2ee(!!r.isE2ee);
        // NOTE: deliberately NO keypair work on open. The web's
        // audited rule (H11) is that a key is generated/published
        // only at first SEND (ensureKeypair runs inside
        // encryptForRoom) — publishing on view made a second device
        // rotate the account key and break the first device's
        // decryption. Receiving never needs a published key.
        // 1:1 calls live in the chat header (DMs only, like the web).
        if (r.otherUserId) {
          const peerId = r.otherUserId as string;
          const peerName = (r.otherUserName ?? "Someone") as string;
          navigation.setOptions({
            headerRight: () => (
              <View style={{ flexDirection: "row", gap: 4, marginRight: 6 }}>
                <TouchableOpacity
                  style={styles.headBtn}
                  onPress={() =>
                    void startCall(peerId, peerName, "voice", roomId)
                  }
                >
                  <Phone size={19} color={colors.greenDark} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.headBtn}
                  onPress={() =>
                    void startCall(peerId, peerName, "video", roomId)
                  }
                >
                  <Video size={20} color={colors.greenDark} />
                </TouchableOpacity>
              </View>
            ),
          });
        }
      })
      .catch(() => {});
  }, [roomId]);

  // Typing + receipts live in ephemeral stores; re-render on change
  // and on a 1s ticker so stale typing indicators expire.
  useEffect(() => {
    const off = onEphemeralChange(() => setTick((t) => t + 1));
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      off();
      clearInterval(iv);
    };
  }, []);

  const typingKey = typingUsers(roomId).join(",");
  useEffect(() => {
    const ids = typingKey ? typingKey.split(",") : [];
    let alive = true;
    (async () => {
      const names: string[] = [];
      for (const id of ids) {
        try {
          const p: any = await profilesCol.find(id);
          names.push((p.displayName ?? "Someone").split(" ")[0]);
        } catch {
          names.push("Someone");
        }
      }
      if (alive) {
        setTypingNames((prev) =>
          prev.join("|") === names.join("|") ? prev : names,
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [typingKey]);

  const query = useMemo(
    () =>
      messagesCol
        .query(Q.where("room_id", roomId), Q.sortBy("created_at", Q.desc))
        .observe(),
    [roomId],
  );
  const messages = useObserved<Message>(query as any);

  const reactionsQuery = useMemo(
    () => reactionsCol.query().observe(),
    [],
  );
  const allReactions = useObserved<Reaction>(reactionsQuery as any);
  const reactionsByMessage = useMemo(() => {
    const map = new Map<string, Map<string, { count: number; mine: boolean }>>();
    for (const r of allReactions) {
      let byEmoji = map.get(r.messageId);
      if (!byEmoji) {
        byEmoji = new Map();
        map.set(r.messageId, byEmoji);
      }
      const cur = byEmoji.get(r.emoji) ?? { count: 0, mine: false };
      cur.count += 1;
      if (r.userId === user?.id) cur.mine = true;
      byEmoji.set(r.emoji, cur);
    }
    return map;
  }, [allReactions, user?.id]);

  async function onSend() {
    const body = draft.trim();
    if (!body || !user) return;
    setDraft("");
    void clearTyping(roomId);
    if (editing) {
      const target = editing;
      setEditing(null);
      const ok = await editMessage(user.id, target, body);
      if (!ok) Alert.alert("Edit failed", "This message can no longer be edited.");
      return;
    }
    await sendText(user.id, roomId, body);
  }

  async function onStartRecording() {
    if (!user || recording) return;
    const ok = await ensureMicPermission();
    if (!ok) {
      Alert.alert(
        "Microphone needed",
        "Allow microphone access to record voice messages.",
      );
      return;
    }
    setRecordMs(0);
    setRecording(true);
    try {
      await startRecording((ms) => setRecordMs(ms));
    } catch {
      setRecording(false);
      Alert.alert("Recorder failed", "Could not start recording.");
    }
  }

  async function onCancelRecording() {
    setRecording(false);
    await cancelRecording();
  }

  async function onSendRecording() {
    if (!user) return;
    setRecording(false);
    const { uri, durationMs } = await stopRecording();
    await sendMediaMessage(
      user.id,
      roomId,
      {
        uri,
        fileName: `voice-${Date.now()}.m4a`,
        mime: "audio/mp4",
        size: 0,
        durationMs: durationMs || recordMs,
      },
      "",
    );
  }

  async function onPickImage() {
    if (!user) return;
    const asset = await pickImage();
    if (!asset) return;
    const caption = draft.trim();
    setDraft("");
    await sendMediaMessage(user.id, roomId, asset, caption);
  }

  async function retry(msg: Message) {
    if (!user) return;
    await database.write(async () => {
      await (msg as any).update((r: any) => {
        r.status = "pending";
      });
    });
    void pushPending(user.id);
  }

  function openMenu(m: Message) {
    if (!user) return;
    const mine = m.senderId === user.id;
    const withinWindow = Date.now() - m.createdAt.getTime() < EDIT_WINDOW_MS;
    const buttons: any[] = QUICK_REACT.map((emoji) => ({
      text: emoji,
      onPress: () => void toggleReaction(user.id, m.id, emoji),
    }));
    if (mine && m.msgType === "text" && withinWindow && m.status === "synced") {
      buttons.push({
        text: "Edit message",
        onPress: () => {
          setEditing(m);
          setDraft(m.body);
        },
      });
      buttons.push({
        text: "Delete message",
        style: "destructive",
        onPress: () => {
          Alert.alert("Delete this message?", "", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Delete",
              style: "destructive",
              onPress: () => {
                void (async () => {
                  const ok = await deleteMessage(user.id, m);
                  if (!ok) {
                    Alert.alert(
                      "Could not delete",
                      "The 5-minute delete window may have expired.",
                    );
                  }
                })();
              },
            },
          ]);
        },
      });
    }
    buttons.push({ text: "Cancel", style: "cancel" });
    Alert.alert("Message", undefined, buttons);
  }

  const typingLabel =
    typingNames.length === 0
      ? null
      : typingNames.length === 1
        ? `${typingNames[0]} is typing…`
        : "Several people are typing…";

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <FlatList
        ref={listRef}
        data={messages}
        inverted
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        renderItem={({ item: m }) => {
          const mine = m.senderId === user?.id;
          if (m.msgType === "call") {
            let label = "📞 Call";
            let callType: "voice" | "video" = "voice";
            try {
              const p = JSON.parse(m.body);
              callType = (p.type ?? p.call) === "video" ? "video" : "voice";
              const icon = callType === "video" ? "📹" : "📞";
              const name = callType === "video" ? "Video call" : "Voice call";
              label =
                p.status === "missed"
                  ? `${icon} Missed ${callType} call`
                  : p.status === "declined"
                    ? `${icon} ${name} · Declined`
                    : p.status === "cancelled"
                      ? `${icon} Cancelled ${callType} call`
                      : p.status === "failed"
                        ? `${icon} ${name} · Failed`
                        : `${icon} ${name}${
                            typeof p.duration === "number"
                              ? ` · ${Math.floor(p.duration / 60)}:${String(p.duration % 60).padStart(2, "0")}`
                              : ""
                          }`;
            } catch {
              /* unparseable call payload — fixed label, never raw body */
            }
            return (
              <View style={styles.callPillRow}>
                <TouchableOpacity
                  style={styles.callPill}
                  activeOpacity={0.85}
                  onPress={async () => {
                    const r: any = await roomsCol
                      .find(roomId)
                      .catch(() => null);
                    if (r?.otherUserId) {
                      void startCall(
                        r.otherUserId,
                        r.otherUserName ?? "Someone",
                        callType,
                        roomId,
                      );
                    }
                  }}
                >
                  <Text style={styles.callPillText}>{label}</Text>
                  <Text style={styles.callPillTime}>
                    {formatBubbleTime(m.createdAt)}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          }
          const chips = reactionsByMessage.get(m.id);
          const read =
            mine && m.status === "synced" && someoneReadAt(roomId, m.createdAt.getTime());
          return (
            <View
              style={[styles.bubbleRow, mine ? styles.rowMine : styles.rowOther]}
            >
              <TouchableOpacity
                activeOpacity={0.85}
                onLongPress={() => openMenu(m)}
                delayLongPress={280}
                style={[
                  styles.bubble,
                  mine ? styles.bubbleMine : styles.bubbleOther,
                ]}
              >
                {m.msgType === "image" ? (
                  <>
                    <MediaImage msg={m} onPress={setViewing} />
                    {!!m.body && (
                      <Text
                        style={[
                          styles.body,
                          mine && styles.bodyMine,
                          { marginTop: 6 },
                        ]}
                      >
                        {m.body}
                      </Text>
                    )}
                  </>
                ) : m.msgType === "audio" ? (
                  <VoiceNoteBubble msg={m} mine={mine} />
                ) : m.msgType === "text" ? (
                  <Text style={[styles.body, mine && styles.bodyMine]}>
                    {m.body}
                  </Text>
                ) : (
                  <View style={styles.fileChip}>
                    <FileIcon size={16} color={mine ? "#fff" : colors.greenDark} />
                    <Text
                      style={[styles.fileName, mine && styles.bodyMine]}
                      numberOfLines={1}
                    >
                      {parseMeta(m.attachmentMeta).name ?? `[${m.msgType}]`}
                    </Text>
                  </View>
                )}
                <View style={styles.meta}>
                  {m.editedAt ? (
                    <Text style={[styles.time, mine && styles.timeMine]}>
                      edited
                    </Text>
                  ) : null}
                  <Text style={[styles.time, mine && styles.timeMine]}>
                    {formatBubbleTime(m.createdAt)}
                  </Text>
                  {mine && m.status === "pending" && (
                    <Clock size={11} color="rgba(255,255,255,0.85)" />
                  )}
                  {mine && m.status === "synced" &&
                    (read ? (
                      <CheckCheck size={13} color="#B9F6CA" />
                    ) : (
                      <Check size={13} color="rgba(255,255,255,0.8)" />
                    ))}
                  {mine && m.status === "failed" && (
                    <TouchableOpacity
                      onPress={() => retry(m)}
                      style={styles.retry}
                    >
                      <TriangleAlert size={11} color="#FFE1E1" />
                      <Text style={styles.retryText}>Retry</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {chips && chips.size > 0 && (
                  <View style={styles.chips}>
                    {[...chips.entries()].map(([emoji, info]) => (
                      <TouchableOpacity
                        key={emoji}
                        style={[styles.chip, info.mine && styles.chipMine]}
                        onPress={() =>
                          user && void toggleReaction(user.id, m.id, emoji)
                        }
                      >
                        <Text style={styles.chipText}>
                          {emoji} {info.count}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </TouchableOpacity>
            </View>
          );
        }}
      />
      {typingLabel && (
        <View style={styles.typingBar}>
          <Text style={styles.typingText}>{typingLabel}</Text>
        </View>
      )}
      {editing && (
        <View style={styles.editBar}>
          <Text style={styles.editText} numberOfLines={1}>
            Editing: {editing.body}
          </Text>
          <TouchableOpacity
            onPress={() => {
              setEditing(null);
              setDraft("");
            }}
          >
            <X size={16} color={colors.greenDark} />
          </TouchableOpacity>
        </View>
      )}
      {isE2ee && (
        <View style={styles.e2eeBar}>
          <Text style={styles.e2eeText}>
            🔒 Messages are end-to-end encrypted
          </Text>
        </View>
      )}
      {recording ? (
        <View style={styles.composer}>
          <TouchableOpacity
            style={styles.attachBtn}
            onPress={() => void onCancelRecording()}
            activeOpacity={0.8}
          >
            <Trash2 size={20} color="#CA4B55" />
          </TouchableOpacity>
          <View style={styles.recInfo}>
            <View style={styles.recDot} />
            <Text style={styles.recTime}>{formatDuration(recordMs)}</Text>
            <Text style={styles.recHint}>Recording…</Text>
          </View>
          <TouchableOpacity
            style={styles.sendBtn}
            onPress={() => void onSendRecording()}
            activeOpacity={0.85}
          >
            <SendHorizonal size={19} color="#fff" />
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.composer}>
          <TouchableOpacity
            style={styles.attachBtn}
            onPress={() => void onPickImage()}
            activeOpacity={0.8}
          >
            <Paperclip size={20} color={colors.greenDark} />
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={(t) => {
              setDraft(t);
              if (t.trim() && !editing) void setTyping(roomId);
              if (!t.trim()) void clearTyping(roomId);
            }}
            placeholder="Message"
            placeholderTextColor="#9DB4A9"
            multiline
          />
          {draft.trim() || editing ? (
            <TouchableOpacity
              style={styles.sendBtn}
              onPress={onSend}
              activeOpacity={0.85}
            >
              <SendHorizonal size={19} color="#fff" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.sendBtn}
              onPress={() => void onStartRecording()}
              activeOpacity={0.85}
            >
              <Mic size={19} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      )}
      <Modal
        visible={!!viewing}
        transparent
        animationType="fade"
        onRequestClose={() => setViewing(null)}
      >
        <TouchableOpacity
          style={styles.viewer}
          activeOpacity={1}
          onPress={() => setViewing(null)}
        >
          {viewing && (
            <Image
              source={{ uri: viewing }}
              style={styles.viewerImage}
              resizeMode="contain"
            />
          )}
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  list: { paddingHorizontal: 14, paddingVertical: 12 },
  bubbleRow: { flexDirection: "row", marginBottom: 3 },
  rowMine: { justifyContent: "flex-end" },
  rowOther: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "78%",
    borderRadius: 19,
    paddingHorizontal: 13,
    paddingTop: 9,
    paddingBottom: 7,
  },
  bubbleMine: {
    backgroundColor: colors.bubbleOwn,
    borderBottomRightRadius: 6,
  },
  bubbleOther: {
    backgroundColor: colors.bubbleOther,
    borderBottomLeftRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
  },
  body: { fontFamily: font.regular, fontSize: 15, color: colors.ink, lineHeight: 21 },
  bodyMine: { color: "#FFFFFF" },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-end",
    marginTop: 3,
  },
  time: { fontFamily: font.medium, fontSize: 10.5, color: colors.timeMuted },
  timeMine: { color: "rgba(255,255,255,0.8)" },
  retry: { flexDirection: "row", alignItems: "center", gap: 3 },
  retryText: {
    fontFamily: font.bold,
    fontSize: 10.5,
    color: "#FFE1E1",
    textDecorationLine: "underline",
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 5,
  },
  chip: {
    backgroundColor: "rgba(0,0,0,0.14)",
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  chipMine: { backgroundColor: colors.mint },
  chipText: { fontSize: 11.5, color: colors.ink },
  typingBar: {
    paddingHorizontal: 18,
    paddingVertical: 5,
    backgroundColor: colors.mintPale,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  typingText: {
    fontFamily: font.medium,
    fontSize: 12,
    color: colors.greenDark,
    fontStyle: "italic",
  },
  editBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 7,
    backgroundColor: colors.mint,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  editText: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: 12.5,
    color: colors.greenDark,
  },
  e2eeBar: {
    backgroundColor: colors.mintPale,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  e2eeText: {
    fontFamily: font.medium,
    fontSize: 12.5,
    color: colors.greenDark,
    lineHeight: 18,
    textAlign: "center",
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 9,
    paddingHorizontal: 12,
    paddingTop: 9,
    paddingBottom: 12,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  input: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.mintPale,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    maxHeight: 110,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { opacity: 0.4 },
  attachBtn: {
    width: 40,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  chatImage: { width: 232, borderRadius: 12, backgroundColor: "rgba(0,0,0,0.08)" },
  imgPlaceholder: {
    width: 232,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  imgPlaceholderText: {
    fontFamily: font.medium,
    fontSize: 12,
    color: colors.timeMuted,
  },
  fileChip: { flexDirection: "row", alignItems: "center", gap: 7, maxWidth: 220 },
  fileName: {
    fontFamily: font.medium,
    fontSize: 13.5,
    color: colors.ink,
    flexShrink: 1,
  },
  viewer: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.94)",
    alignItems: "center",
    justifyContent: "center",
  },
  viewerImage: { width: "100%", height: "100%" },
  voiceRow: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 2 },
  voiceBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceBtnMine: { backgroundColor: "#fff" },
  voiceDur: { fontFamily: font.medium, fontSize: 13, color: colors.ink },
  recInfo: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  recDot: { width: 10, height: 10, borderRadius: 999, backgroundColor: "#CA4B55" },
  recTime: { fontFamily: font.bold, fontSize: 15, color: colors.ink },
  recHint: { fontFamily: font.medium, fontSize: 12.5, color: colors.timeMuted },
  headBtn: { padding: 7 },
  callPillRow: { alignItems: "center", marginVertical: 5 },
  callPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.mintPale,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  callPillText: {
    fontFamily: font.medium,
    fontSize: 12.5,
    color: colors.greenDark,
  },
  callPillTime: {
    fontFamily: font.medium,
    fontSize: 10.5,
    color: colors.timeMuted,
  },
});
