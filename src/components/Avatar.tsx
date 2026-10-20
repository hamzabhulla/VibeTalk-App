import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { paletteFor, initialsOf, font } from "../theme";

// Web parity: photo if the person has one, else the pastel tile with
// deep-ink initials (same palette hash as the web).
export function Avatar({
  name,
  avatarUrl,
  size = 50,
}: {
  name: string;
  avatarUrl?: string | null;
  size?: number;
}) {
  if (avatarUrl) {
    return (
      <Image
        source={{ uri: avatarUrl }}
        style={{ width: size, height: size, borderRadius: size / 2.6 }}
      />
    );
  }
  const pal = paletteFor(name || "?");
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: size / 2.6,
          backgroundColor: pal.bg,
        },
      ]}
    >
      <Text
        style={{
          color: pal.fg,
          fontFamily: font.bold,
          fontSize: size * 0.36,
          letterSpacing: -0.3,
        }}
      >
        {initialsOf(name)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center" },
});
