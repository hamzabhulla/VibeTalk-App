import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import {
  PhoneOutgoing,
  PhoneIncoming,
  PhoneMissed,
  Video,
  Phone,
} from "lucide-react-native";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { startCall, type CallType } from "../lib/calls";
import { Avatar } from "../components/Avatar";
import { colors, font } from "../theme";

type InviteRow = {
  id: string;
  caller_id: string;
  callee_id: string;
  caller_name: string;
  type: CallType;
  status: string;
  created_at: string;
};

// Call history derives from call_invites (participant-readable):
// web calls appear here too, because the web server writes a row
// for every call it rings.
export function CallsScreen() {
  const { user } = useAuth();
  const [rows, setRows] = useState<InviteRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("call_invites")
      .select("id, caller_id, callee_id, caller_name, type, status, created_at")
      .or(`caller_id.eq.${user.id},callee_id.eq.${user.id}`)
      .order("created_at", { ascending: false })
      .limit(60);
    const list = (data ?? []) as InviteRow[];
    setRows(list);
    // Resolve callee names (caller_name covers only one direction).
    const need = [
      ...new Set(
        list
          .map((r) => (r.caller_id === user.id ? r.callee_id : r.caller_id))
          .filter((id) => !names.has(id)),
      ),
    ];
    if (need.length) {
      const { data: pubs } = await supabase
        .from("profiles_public")
        .select("id, display_name")
        .in("id", need);
      setNames((prev) => {
        const next = new Map(prev);
        for (const p of (pubs ?? []) as any[]) {
          next.set(p.id, p.display_name ?? "Someone");
        }
        return next;
      });
    }
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function when(iso: string) {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No calls yet</Text>
            <Text style={styles.emptyBody}>
              Voice and video calls you make or receive will show up
              here. Start one from any chat — tap the phone or video
              icon at the top.
            </Text>
          </View>
        }
        renderItem={({ item: r }) => {
          const outgoing = r.caller_id === user?.id;
          const peerId = outgoing ? r.callee_id : r.caller_id;
          const peerName = outgoing
            ? (names.get(peerId) ?? "Someone")
            : r.caller_name || (names.get(peerId) ?? "Someone");
          const missed =
            !outgoing && r.status !== "accepted" && r.status !== "ended";
          const Icon = missed
            ? PhoneMissed
            : outgoing
              ? PhoneOutgoing
              : PhoneIncoming;
          const iconColor = missed ? "#CA4B55" : colors.greenDark;
          return (
            <View style={styles.row}>
              <Avatar name={peerName} size={46} />
              <View style={styles.mid}>
                <Text style={styles.name} numberOfLines={1}>
                  {peerName}
                </Text>
                <View style={styles.subRow}>
                  <Icon size={13} color={iconColor} />
                  <Text style={styles.sub}>
                    {r.type === "video" ? "Video" : "Voice"} · {when(r.created_at)}
                    {r.status === "ringing" ? " · ringing" : ""}
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                style={styles.callBtn}
                onPress={() => void startCall(peerId, peerName, "voice")}
              >
                <Phone size={18} color={colors.greenDark} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.callBtn}
                onPress={() => void startCall(peerId, peerName, "video")}
              >
                <Video size={19} color={colors.greenDark} />
              </TouchableOpacity>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  mid: { flex: 1, gap: 3 },
  name: { fontFamily: font.bold, fontSize: 15.5, color: colors.ink },
  subRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  sub: { fontFamily: font.medium, fontSize: 12.5, color: colors.muted },
  callBtn: {
    width: 38,
    height: 38,
    borderRadius: 999,
    backgroundColor: colors.mintPale,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: {
    alignItems: "center",
    paddingHorizontal: 36,
    paddingTop: 90,
    gap: 8,
  },
  emptyTitle: {
    fontFamily: font.bold,
    fontSize: 18,
    color: colors.ink,
    textAlign: "center",
  },
  emptyBody: {
    fontFamily: font.regular,
    fontSize: 13.5,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 20,
  },
});
