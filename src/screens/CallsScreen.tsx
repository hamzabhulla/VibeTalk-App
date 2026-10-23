import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
} from "react-native";
import { Q } from "@nozbe/watermelondb";
import {
  PhoneOutgoing,
  PhoneIncoming,
  PhoneMissed,
  Video,
  Phone,
} from "lucide-react-native";
import { messagesCol, roomsCol } from "../db";
import type { Message, Room } from "../db/models";
import { useObserved } from "../components/hooks";
import { useAuth } from "../lib/auth";
import { pullEverything } from "../lib/sync";
import { startCall, type CallType } from "../lib/calls";
import { Avatar } from "../components/Avatar";
import { colors, font } from "../theme";

// Call history is derived from the call entries in the local database
// (the caller posts one into the chat for EVERY call - web and mobile
// alike). The old version read the server's call_invites table, which
// has no row for mobile-originated calls, so those never showed up, and
// it needed the network to show anything.
type CallEntry = {
  id: string;
  roomId: string;
  peerId: string;
  peerName: string;
  type: CallType;
  outgoing: boolean;
  status: string;
  duration: number | null;
  at: number;
};

function parseCall(m: Message): {
  type: CallType;
  status: string;
  duration: number | null;
} {
  try {
    const p = JSON.parse(m.body);
    return {
      type: (p.type ?? p.call) === "video" ? "video" : "voice",
      status: String(p.status ?? "completed"),
      duration: typeof p.duration === "number" ? p.duration : null,
    };
  } catch {
    return { type: "voice", status: "completed", duration: null };
  }
}

export function CallsScreen() {
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);

  const callsQuery = useMemo(
    () =>
      messagesCol
        .query(
          Q.where("msg_type", "call"),
          Q.sortBy("created_at", Q.desc),
          Q.take(100),
        )
        .observe(),
    [],
  );
  const roomsQuery = useMemo(() => roomsCol.query().observe(), []);
  const callMsgs = useObserved<Message>(callsQuery as any);
  const rooms = useObserved<Room>(roomsQuery as any);

  const entries = useMemo<CallEntry[]>(() => {
    const roomById = new Map<string, any>(rooms.map((r: any) => [r.id, r]));
    const out: CallEntry[] = [];
    for (const m of callMsgs as any[]) {
      const room = roomById.get(m.roomId);
      if (!room?.otherUserId) continue; // 1:1 calls only
      const info = parseCall(m);
      out.push({
        id: m.id,
        roomId: m.roomId,
        peerId: room.otherUserId,
        peerName: room.otherUserName ?? "Someone",
        type: info.type,
        outgoing: m.senderId === user?.id,
        status: info.status,
        duration: info.duration,
        at: m.createdAt.getTime(),
      });
    }
    return out;
  }, [callMsgs, rooms, user?.id]);

  async function onRefresh() {
    if (!user) return;
    setRefreshing(true);
    try {
      await pullEverything(user.id);
    } catch {
      /* offline - the local history stays */
    }
    setRefreshing(false);
  }

  async function redial(e: CallEntry, type: CallType) {
    const ok = await startCall(e.peerId, e.peerName, type, e.roomId);
    if (!ok) {
      Alert.alert(
        "Couldn't start the call",
        "Check the microphone/camera permission and your connection.",
      );
    }
  }

  function when(ms: number) {
    const d = new Date(ms);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function statusText(e: CallEntry) {
    if (e.status === "missed") return e.outgoing ? "No answer" : "Missed";
    if (e.status === "declined") return "Declined";
    if (e.status === "cancelled") return e.outgoing ? "Cancelled" : "Missed";
    if (e.status === "failed") return "Failed";
    if (e.duration && e.duration > 0) {
      return `${Math.floor(e.duration / 60)}:${String(e.duration % 60).padStart(2, "0")}`;
    }
    return "";
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={entries}
        keyExtractor={(e) => e.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No calls yet</Text>
            <Text style={styles.emptyBody}>
              Voice and video calls you make or receive will show up here.
              Start one from any one-to-one chat - tap the phone or video icon
              at the top.
            </Text>
          </View>
        }
        renderItem={({ item: e }) => {
          const missed =
            !e.outgoing && (e.status === "missed" || e.status === "cancelled");
          const Icon = missed
            ? PhoneMissed
            : e.outgoing
              ? PhoneOutgoing
              : PhoneIncoming;
          const iconColor = missed ? "#CA4B55" : colors.greenDark;
          const st = statusText(e);
          return (
            <View style={styles.row}>
              <Avatar name={e.peerName} size={46} />
              <View style={styles.mid}>
                <Text style={styles.name} numberOfLines={1}>
                  {e.peerName}
                </Text>
                <View style={styles.subRow}>
                  <Icon size={13} color={iconColor} />
                  <Text style={styles.sub}>
                    {e.type === "video" ? "Video" : "Voice"} · {when(e.at)}
                    {st ? ` · ${st}` : ""}
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                style={styles.callBtn}
                onPress={() => void redial(e, "voice")}
              >
                <Phone size={18} color={colors.greenDark} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.callBtn}
                onPress={() => void redial(e, "video")}
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
