import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, font } from "../theme";

// Web mobile-shell parity: mini logo + VIBETALK kicker + screen title.
export function ScreenHead({ title }: { title: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.head, { paddingTop: insets.top + 12 }]}>
      <Image
        source={require("../../assets/logo-mark.png")}
        style={styles.logo}
        resizeMode="contain"
      />
      <View>
        <Text style={styles.kicker}>VIBETALK</Text>
        <Text style={styles.title}>{title}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 18,
    paddingBottom: 10,
    backgroundColor: colors.bg,
  },
  logo: { width: 34, height: 34 },
  kicker: {
    fontFamily: font.extrabold,
    fontSize: 9,
    letterSpacing: 1.8,
    color: colors.green,
  },
  title: {
    fontFamily: font.extrabold,
    fontSize: 24,
    color: colors.ink,
    letterSpacing: -0.65,
  },
});
