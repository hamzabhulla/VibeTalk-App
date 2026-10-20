import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { PhoneCall } from "lucide-react-native";
import { colors, font } from "../theme";

// Honest v1: native WebRTC calling is the next milestone. Calls work
// today in the VibeTalk web app on this same account.
export function CallsScreen() {
  return (
    <View style={styles.screen}>
      <View style={styles.iconWrap}>
        <PhoneCall size={30} color={colors.greenDark} />
      </View>
      <Text style={styles.title}>Calls are coming to Android</Text>
      <Text style={styles.body}>
        Voice and video calls already work in the VibeTalk web app with
        this same account. Native calling lands in the next app update —
        this tab is ready for it.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 34,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 24,
    backgroundColor: colors.mint,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 18,
  },
  title: {
    fontFamily: font.bold,
    fontSize: 19,
    color: colors.ink,
    textAlign: "center",
    marginBottom: 8,
  },
  body: {
    fontFamily: font.regular,
    fontSize: 13.5,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 20,
  },
});
