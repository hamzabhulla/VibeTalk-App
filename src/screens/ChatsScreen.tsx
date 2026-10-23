import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
} from "react-native";
import { Q } from "@nozbe/watermelondb";
import { roomsCol } from "../db";
import type { Room } from "../db/models";
import { Avatar } from "../components/Avatar";
import { useObserved, formatListTime } from "../components/hooks";
import { useAuth } from "../lib/auth";
import { pullEverything, pushPending } from "../lib/sync";
import { colors, font } from "../theme";

export function ChatsScreen({ navigation }: any) {
  const { user } = useAuth();
  const query = useMemo(
    () => roomsCol.query(Q.sortBy("last_message_at", Q.desc)).observe(),
    [],
  );
  const rooms = useObserved<Room>(query as any);
  const [refreshing, setRefreshing] = useState(false);

  // Pull-to-refresh: flush the outbox, then fetch anything missed.
  async function onRefresh() {
    if (!user) return;
    setRefreshing(true);
    try {
      await pushPending(user.id);
      await pullEverything(user.id);
    } catch {
      /* offline - local data stays as is */
    }
    setRefreshing(false);
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={rooms}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No chats yet</Text>
            <Text style={styles.emptyBody}>
              Start a conversation from the People tab — it will live
              here, on this device, even without internet.
            </Text>
          </View>
        }
        renderItem={({ item: room }) => {
          const mine = room.lastSenderId === user?.id;
          return (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={() =>
                navigation.navigate("Chat", {
                  roomId: room.id,
                  title: room.title,
                })
              }
            >
              <Avatar name={room.title} size={52} />
              <View style={styles.rowMain}>
                <View style={styles.rowTop}>
                  <Text style={styles.name} numberOfLines={1}>
                    {room.title}
                    {room.isE2ee ? "  🔒" : ""}
                  </Text>
                  <Text style={styles.time}>
                    {formatListTime(room.lastMessageAt)}
                  </Text>
                </View>
                <View style={styles.rowBottom}>
                  <Text
                    style={[
                      styles.preview,
                      room.unreadCount > 0 && styles.previewUnread,
                    ]}
                    numberOfLines={1}
                  >
                    {room.lastMessageBody
                      ? `${mine ? "You: " : ""}${room.lastMessageBody}`
                      : "Say hello 👋"}
                  </Text>
                  {room.unreadCount > 0 && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>
                        {room.unreadCount > 99 ? "99+" : room.unreadCount}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  list: { paddingHorizontal: 17, paddingTop: 10, paddingBottom: 18 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 20,
    paddingHorizontal: 13,
    paddingVertical: 12,
    marginBottom: 9,
    shadowColor: "rgba(20,83,45,1)",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  rowMain: { flex: 1, minWidth: 0 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 8,
  },
  name: {
    fontFamily: font.bold,
    fontSize: 15.5,
    color: colors.ink,
    flexShrink: 1,
  },
  time: { fontFamily: font.medium, fontSize: 11, color: colors.timeMuted },
  rowBottom: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 3,
  },
  preview: {
    fontFamily: font.medium,
    fontSize: 13,
    color: colors.muted,
    flex: 1,
  },
  previewUnread: { color: colors.ink, fontFamily: font.semibold },
  badge: {
    backgroundColor: colors.green,
    borderRadius: 999,
    minWidth: 21,
    height: 21,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#fff", fontFamily: font.extrabold, fontSize: 11 },
  empty: { alignItems: "center", paddingTop: 80, paddingHorizontal: 30 },
  emptyTitle: {
    fontFamily: font.bold,
    fontSize: 19,
    color: colors.ink,
    marginBottom: 8,
  },
  emptyBody: {
    fontFamily: font.regular,
    fontSize: 13.5,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 20,
  },
});
