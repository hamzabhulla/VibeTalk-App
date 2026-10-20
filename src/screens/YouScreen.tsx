import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Q } from "@nozbe/watermelondb";
import { LogOut, RefreshCw } from "lucide-react-native";
import { profilesCol } from "../db";
import type { Profile } from "../db/models";
import { Avatar } from "../components/Avatar";
import { useObserved } from "../components/hooks";
import { useAuth } from "../lib/auth";
import { pullEverything, pushPending } from "../lib/sync";
import { colors, font } from "../theme";

export function YouScreen() {
  const { user, signOut } = useAuth();
  const [syncing, setSyncing] = useState(false);
  const query = useMemo(
    () =>
      user
        ? profilesCol.query(Q.where("id", user.id)).observe()
        : null,
    [user?.id],
  );
  const mine = useObserved<Profile>(query as any);
  const me = mine[0];
  const name =
    me?.displayName ??
    (user?.user_metadata?.display_name as string | undefined) ??
    "You";

  async function onSyncNow() {
    if (!user || syncing) return;
    setSyncing(true);
    try {
      await pushPending(user.id);
      await pullEverything(user.id);
    } catch {
      Alert.alert("Sync failed", "Check your connection and try again.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Avatar name={name} avatarUrl={me?.avatarUrl} size={72} />
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.email}>{user?.email}</Text>
        {me?.customStatus ? (
          <Text style={styles.status}>{me.customStatus}</Text>
        ) : null}
        {me?.bio ? <Text style={styles.bio}>{me.bio}</Text> : null}
      </View>

      <TouchableOpacity
        style={styles.action}
        onPress={onSyncNow}
        activeOpacity={0.7}
      >
        <RefreshCw size={19} color={colors.greenDark} />
        <Text style={styles.actionText}>Sync now</Text>
        {syncing && <ActivityIndicator size="small" color={colors.green} />}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.action}
        onPress={() =>
          Alert.alert(
            "Sign out?",
            "Your offline chats on this device will be removed. They stay safe on the server and on the web.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Sign out",
                style: "destructive",
                onPress: () => void signOut(),
              },
            ],
          )
        }
        activeOpacity={0.7}
      >
        <LogOut size={19} color={colors.destructive} />
        <Text style={[styles.actionText, { color: colors.destructive }]}>
          Sign out
        </Text>
      </TouchableOpacity>

      <Text style={styles.footnote}>
        VibeTalk for Android — offline-first. Messages you send without
        internet are stored on this device and delivered automatically
        when you are back online.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: 17 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    alignItems: "center",
    paddingVertical: 26,
    paddingHorizontal: 18,
    marginBottom: 12,
    elevation: 1,
  },
  name: {
    fontFamily: font.extrabold,
    fontSize: 21,
    color: colors.ink,
    letterSpacing: -0.4,
    marginTop: 13,
  },
  email: {
    fontFamily: font.medium,
    fontSize: 13,
    color: colors.muted,
    marginTop: 3,
  },
  status: {
    fontFamily: font.semibold,
    fontSize: 13,
    color: colors.greenDark,
    marginTop: 8,
  },
  bio: {
    fontFamily: font.regular,
    fontSize: 13,
    color: colors.muted,
    marginTop: 5,
    textAlign: "center",
    lineHeight: 19,
  },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 15,
    marginBottom: 9,
    elevation: 1,
  },
  actionText: { fontFamily: font.bold, fontSize: 15, color: colors.ink, flex: 1 },
  footnote: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.muted,
    lineHeight: 18,
    textAlign: "center",
    marginTop: 16,
    paddingHorizontal: 14,
  },
});
