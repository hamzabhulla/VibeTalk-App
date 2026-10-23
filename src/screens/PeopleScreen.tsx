import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Alert,
} from "react-native";
import { Q } from "@nozbe/watermelondb";
import { profilesCol, roomsCol, upsertById } from "../db";
import type { Profile } from "../db/models";
import { Avatar } from "../components/Avatar";
import { useObserved } from "../components/hooks";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { colors, font } from "../theme";

// People mirrors the web's public directory: profiles_public already
// applies every person's visibility choices server-side.
export function PeopleScreen({ navigation }: any) {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const query = useMemo(
    () => profilesCol.query(Q.sortBy("display_name")).observe(),
    [],
  );
  const all = useObserved<Profile>(query as any);
  const people = all.filter(
    (p) =>
      p.id !== user?.id &&
      (!search ||
        p.displayName.toLowerCase().includes(search.toLowerCase())),
  );

  async function openDm(person: Profile) {
    if (!user || busyId) return;
    // Already have this DM locally? Jump straight in (offline-safe).
    const local = await roomsCol
      .query(Q.where("other_user_id", person.id))
      .fetch();
    if (local.length > 0) {
      navigation.navigate("ChatsTab", {
        screen: "Chat",
        params: { roomId: local[0].id, title: local[0].title },
      });
      return;
    }
    setBusyId(person.id);
    try {
      // The web creates DMs only through this RPC (atomic
      // find-or-create incl. both membership rows).
      const { data: roomId, error } = await supabase.rpc(
        "get_or_create_dm",
        { _other: person.id },
      );
      if (error || !roomId) throw error ?? new Error("Could not create chat");
      await upsertById(roomsCol as any, roomId as string, (rec: any) => {
        rec.isGroup = false;
        rec.isE2ee = false;
        rec.createdAt = new Date();
        rec.unreadCount = 0;
        rec.otherUserId = person.id;
        rec.otherUserName = person.displayName;
      });
      navigation.navigate("ChatsTab", {
        screen: "Chat",
        params: { roomId: roomId as string, title: person.displayName },
      });
    } catch {
      Alert.alert(
        "Could not start chat",
        "You need internet for the first chat with someone new. Your existing chats work fully offline.",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.searchWrap}>
        <TextInput
          style={styles.search}
          value={search}
          onChangeText={setSearch}
          placeholder="Search people"
          placeholderTextColor="#9DB4A9"
        />
      </View>
      <FlatList
        data={people}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No people yet</Text>
            <Text style={styles.emptyBody}>
              People appear here after your first sync — open the app
              online once and they will stay available offline.
            </Text>
          </View>
        }
        renderItem={({ item: p }) => (
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => openDm(p)}
            disabled={busyId === p.id}
          >
            <View>
              <Avatar name={p.displayName} avatarUrl={p.avatarUrl} size={50} />
              {p.isOnline && <View style={styles.presenceDot} />}
            </View>
            <View style={styles.rowMain}>
              <Text style={styles.name} numberOfLines={1}>
                {p.displayName}
              </Text>
              <Text style={styles.status} numberOfLines={1}>
                {p.customStatus || p.bio || (p.isOnline ? "Online" : "Offline")}
              </Text>
            </View>
            <View style={styles.msgPill}>
              <Text style={styles.msgPillText}>
                {busyId === p.id ? "…" : "Message"}
              </Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  searchWrap: { paddingHorizontal: 17, paddingTop: 10, paddingBottom: 4 },
  search: {
    fontFamily: font.medium,
    fontSize: 14.5,
    color: colors.ink,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 15,
    paddingHorizontal: 15,
    paddingVertical: 11,
  },
  list: { paddingHorizontal: 17, paddingTop: 8, paddingBottom: 18 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 20,
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginBottom: 9,
    elevation: 1,
  },
  presenceDot: {
    position: "absolute",
    right: -1,
    bottom: -1,
    width: 13,
    height: 13,
    borderRadius: 999,
    backgroundColor: "#22C55E",
    borderWidth: 2.5,
    borderColor: "#fff",
  },
  rowMain: { flex: 1, minWidth: 0 },
  name: { fontFamily: font.bold, fontSize: 15.5, color: colors.ink },
  status: {
    fontFamily: font.medium,
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
  },
  msgPill: {
    backgroundColor: colors.mint,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  msgPillText: {
    fontFamily: font.bold,
    fontSize: 12,
    color: colors.greenDark,
  },
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
