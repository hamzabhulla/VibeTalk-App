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
} from "react-native";
import { Q } from "@nozbe/watermelondb";
import { SendHorizonal, Clock, TriangleAlert } from "lucide-react-native";
import { messagesCol, roomsCol, database } from "../db";
import type { Message } from "../db/models";
import { useObserved, formatBubbleTime } from "../components/hooks";
import { useAuth } from "../lib/auth";
import { sendText, pushPending, setOpenRoom } from "../lib/sync";
import { useFocusEffect } from "@react-navigation/native";
import { colors, font } from "../theme";

export function ChatScreen({ route }: any) {
  const { roomId } = route.params as { roomId: string };
  const { user } = useAuth();
  const [draft, setDraft] = useState("");
  const [isE2ee, setIsE2ee] = useState(false);
  const listRef = useRef<FlatList>(null);

  useFocusEffect(
    React.useCallback(() => {
      setOpenRoom(roomId);
      return () => setOpenRoom(null);
    }, [roomId]),
  );

  useEffect(() => {
    roomsCol
      .find(roomId)
      .then((r: any) => setIsE2ee(!!r.isE2ee))
      .catch(() => {});
  }, [roomId]);

  const query = useMemo(
    () =>
      messagesCol
        .query(
          Q.where("room_id", roomId),
          Q.sortBy("created_at", Q.desc),
        )
        .observe(),
    [roomId],
  );
  const messages = useObserved<Message>(query as any);

  async function onSend() {
    const body = draft.trim();
    if (!body || !user) return;
    setDraft("");
    await sendText(user.id, roomId, body);
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
          return (
            <View
              style={[styles.bubbleRow, mine ? styles.rowMine : styles.rowOther]}
            >
              <View
                style={[
                  styles.bubble,
                  mine ? styles.bubbleMine : styles.bubbleOther,
                ]}
              >
                {m.msgType === "text" ? (
                  <Text style={[styles.body, mine && styles.bodyMine]}>
                    {m.body}
                  </Text>
                ) : (
                  <Text style={[styles.body, mine && styles.bodyMine]}>
                    [{m.msgType}]
                  </Text>
                )}
                <View style={styles.meta}>
                  <Text style={[styles.time, mine && styles.timeMine]}>
                    {formatBubbleTime(m.createdAt)}
                  </Text>
                  {mine && m.status === "pending" && (
                    <Clock size={11} color="rgba(255,255,255,0.85)" />
                  )}
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
              </View>
            </View>
          );
        }}
      />
      {isE2ee ? (
        <View style={styles.e2eeBar}>
          <Text style={styles.e2eeText}>
            🔒 This chat is end-to-end encrypted on the web app. Sending
            from Android arrives in the next milestone — your history
            here stays readable offline.
          </Text>
        </View>
      ) : (
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Message"
            placeholderTextColor="#9DB4A9"
            multiline
          />
          <TouchableOpacity
            style={[
              styles.sendBtn,
              !draft.trim() && styles.sendBtnDisabled,
            ]}
            onPress={onSend}
            disabled={!draft.trim()}
            activeOpacity={0.85}
          >
            <SendHorizonal size={19} color="#fff" />
          </TouchableOpacity>
        </View>
      )}
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
});
