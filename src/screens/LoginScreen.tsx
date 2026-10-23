import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Image,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { useAuth } from "../lib/auth";
import { colors, font } from "../theme";

// Mirrors the web auth design (auth-shell): logo mark + wordmark +
// tagline on top, "Welcome back", labelled fields, deep-green button.
export function LoginScreen({ navigation }: any) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (busy) return;
    setError(null);
    setBusy(true);
    const res = await signIn(email, password);
    setBusy(false);
    if (res.error) setError(res.error);
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <Image
            source={require("../../assets/logo-mark.png")}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.wordmark}>VibeTalk</Text>
          <Text style={styles.tagline}>
            Native Android & web connected chat
          </Text>
        </View>

        <Text style={styles.heading}>Welcome back</Text>
        <Text style={styles.sub}>
          Your conversations are just a sign-in away.
        </Text>

        <Text style={styles.label}>Email address</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          placeholder="you@example.com"
          placeholderTextColor="#9DB4A9"
        />
        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="Your password"
          placeholderTextColor="#9DB4A9"
          onSubmitEditing={onSubmit}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, busy && styles.buttonBusy]}
          onPress={onSubmit}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Sign in</Text>
          )}
        </TouchableOpacity>

        <View style={styles.switchRow}>
          <Text style={styles.switchText}>New to VibeTalk? </Text>
          <TouchableOpacity onPress={() => navigation.navigate("Register")}>
            <Text style={styles.switchLink}>Create an account</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#FFFFFF" },
  container: { paddingHorizontal: 26, paddingTop: 64, paddingBottom: 32 },
  brand: { alignItems: "center", marginBottom: 30 },
  logo: { width: 84, height: 84 },
  wordmark: {
    fontFamily: font.extrabold,
    fontSize: 27,
    color: "#111827",
    letterSpacing: -0.8,
    marginTop: 10,
  },
  tagline: {
    fontFamily: font.medium,
    fontSize: 12.5,
    color: "#6B7280",
    marginTop: 4,
  },
  heading: {
    fontFamily: font.extrabold,
    fontSize: 29,
    color: "#111827",
    letterSpacing: -1.1,
  },
  sub: {
    fontFamily: font.regular,
    fontSize: 13.5,
    color: "#6B7280",
    lineHeight: 21,
    marginTop: 8,
    marginBottom: 22,
  },
  label: {
    fontFamily: font.bold,
    fontSize: 13,
    color: "#172B25",
    marginBottom: 7,
    marginTop: 13,
  },
  input: {
    fontFamily: font.medium,
    fontSize: 15,
    color: "#172B25",
    backgroundColor: colors.mintPale,
    borderWidth: 1,
    borderColor: "#DCFCE7",
    borderRadius: 14,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  error: {
    fontFamily: font.semibold,
    fontSize: 13,
    color: colors.destructive,
    marginTop: 14,
  },
  button: {
    backgroundColor: colors.buttonGreen,
    borderRadius: 14,
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 24,
  },
  buttonBusy: { opacity: 0.75 },
  buttonText: { fontFamily: font.bold, fontSize: 15.5, color: "#FFFFFF" },
  switchRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 20,
  },
  switchText: { fontFamily: font.medium, fontSize: 13, color: "#6B7280" },
  switchLink: { fontFamily: font.bold, fontSize: 13, color: colors.buttonGreen },
});
