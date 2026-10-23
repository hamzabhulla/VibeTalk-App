import React, { useEffect, useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Phone, Video } from "lucide-react-native";
import { roomsCol } from "../db";
import { startCall } from "../lib/calls";
import { Avatar } from "./Avatar";
import { colors, font } from "../theme";

// Custom chat header. A custom `header` REPLACES the navigator's header, so
// `headerRight` set from the screen is never rendered - the call buttons
// must live in here. Uses the real top inset instead of a hard-coded 44.
export function ChatHeader({
  navigation,
  route,
}: {
  navigation: any;
  route: any;
}) {
  const insets = useSafeAreaInsets();
  const roomId: string | undefined = route.params?.roomId;
  const title: string = route.params?.title ?? "Chat";
  const [peer, setPeer] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let alive = true;
    if (!roomId) return;
    roomsCol
      .find(roomId)
      .then((r: any) => {
        if (!alive) return;
        if (!r.isGroup && r.otherUserId) {
          setPeer({ id: r.otherUserId, name: r.otherUserName ?? title });
        } else {
          setPeer(null);
        }
      })
      .catch(() => alive && setPeer(null));
    return () => {
      alive = false;
    };
  }, [roomId, title]);

  const call = async (type: "voice" | "video") => {
    if (!peer) return;
    const ok = await startCall(peer.id, peer.name, type, roomId);
    if (!ok) {
      Alert.alert(
        "Couldn't start the call",
        "Check the microphone/camera permission and your connection, then try again.",
      );
    }
  };

  return (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      <TouchableOpacity
        onPress={() => navigation.goBack()}
        style={styles.backBtn}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.backArrow}>‹</Text>
      </TouchableOpacity>
      <Avatar name={title} size={38} />
      <Text style={styles.name} numberOfLines={1}>
        {title}
      </Text>
      {peer ? (
        <View style={styles.actions}>
          <TouchableOpacity
            onPress={() => call("voice")}
            style={styles.actionBtn}
            accessibilityLabel="Voice call"
          >
            <Phone size={20} color={colors.greenDark} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => call("video")}
            style={styles.actionBtn}
            accessibilityLabel="Video call"
          >
            <Video size={21} color={colors.greenDark} />
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  backBtn: { paddingHorizontal: 4, paddingVertical: 2 },
  backArrow: { fontSize: 30, color: colors.greenDark, lineHeight: 32 },
  name: { fontFamily: font.bold, fontSize: 16.5, color: colors.ink, flex: 1 },
  actions: { flexDirection: "row", gap: 4 },
  actionBtn: { padding: 8 },
});
