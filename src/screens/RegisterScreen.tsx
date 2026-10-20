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

export function RegisterScreen({ navigation }: any) {
  const { signUp } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit() {
    if (busy) return;
    setError(null);
    if (name.trim().length < 2) {
      setError("Please enter your name.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    const res = await signUp(email, password, name);
    setBusy(false);
    if (res.error) setError(res.error);
    else if (res.needsEmailConfirm) setSent(true);
    // If a session came back immediately, AuthProvider switches the
    // root navigator on its own.
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
        </View>

        {sent ? (
          <>
            <Text style={styles.heading}>Check your email</Text>
            <Text style={styles.sub}>
              We sent a confirmation link to {email.trim()}. Open it to
              verify your account, then come back and sign in.
            </Text>
            <TouchableOpacity
              style={styles.button}
              onPress={() => navigation.navigate("Login")}
              activeOpacity={0.85}
            >
              <Text style={styles.buttonText}>Back to sign in</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.heading}>Create your account</Text>
            <Text style={styles.sub}>
              A little closer, everywhere.
            </Text>

            <Text style={styles.label}>Your name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Hamza"
              placeholderTextColor="#9DB4A9"
            />
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
              placeholder="At least 8 characters"
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
                <Text style={styles.buttonText}>Create account</Text>
              )}
            </TouchableOpacity>

            <View style={styles.switchRow}>
              <Text style={styles.switchText}>Already have an account? </Text>
              <TouchableOpacity onPress={() => navigation.navigate("Login")}>
                <Text style={styles.switchLink}>Sign in</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#FFFFFF" },
  container: { paddingHorizontal: 26, paddingTop: 56, paddingBottom: 32 },
  brand: { alignItems: "center", marginBottom: 26 },
  logo: { width: 76, height: 76 },
  wordmark: {
    fontFamily: font.extrabold,
    fontSize: 25,
    color: "#111827",
    letterSpacing: -0.8,
    marginTop: 8,
  },
  heading: {
    fontFamily: font.extrabold,
    fontSize: 27,
    color: "#111827",
    letterSpacing: -1,
  },
  sub: {
    fontFamily: font.regular,
    fontSize: 13.5,
    color: "#6B7280",
    lineHeight: 21,
    marginTop: 8,
    marginBottom: 10,
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
  switchRow: { flexDirection: "row", justifyContent: "center", marginTop: 20 },
  switchText: { fontFamily: font.medium, fontSize: 13, color: "#6B7280" },
  switchLink: { fontFamily: font.bold, fontSize: 13, color: colors.buttonGreen },
});
