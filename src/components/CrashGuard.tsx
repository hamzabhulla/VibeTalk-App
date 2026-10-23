import React from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { colors } from "../theme";

// Diagnostic error boundary: if the very first render throws (the
// "app closes as soon as it opens" case), show the actual error on
// screen instead of a silent crash, so it can be screenshotted and
// reported. Rendered above everything in App.tsx.
type Props = { children: React.ReactNode };
type State = { error: Error | null };

export class CrashGuard extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[crash-guard] first-render error:", error);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <ScrollView contentContainerStyle={styles.wrap}>
          <Text style={styles.title}>VibeTalk ran into a problem</Text>
          <Text style={styles.message}>{error.message}</Text>
          <Text style={styles.stack}>{error.stack ?? ""}</Text>
          <Text style={styles.hint}>
            Please take a screenshot and send it to Hamza.
          </Text>
        </ScrollView>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  wrap: {
    flexGrow: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.ink,
    marginBottom: 12,
    textAlign: "center",
  },
  message: {
    fontSize: 14,
    color: colors.destructive,
    marginBottom: 12,
    textAlign: "center",
  },
  stack: {
    fontSize: 10,
    color: colors.muted,
    marginBottom: 16,
  },
  hint: { fontSize: 12, color: colors.muted, textAlign: "center" },
});
