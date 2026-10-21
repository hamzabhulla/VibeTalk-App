// Push notifications — TEMPORARILY DISABLED in v1.0.11 (diagnostic).
// Firebase was removed to isolate the immediate-crash-on-open; the
// placeholder google-services.json was the prime suspect. The original
// FCM implementation is preserved in git history (see commit before
// v1.0.11). Re-enable by restoring @react-native-firebase/app +
// @react-native-firebase/messaging, the google-services plugin, and the
// real google-services.json from Hamza's Firebase project.

export async function initPush(_uid: string): Promise<void> {
  console.log("[push] disabled in this build (Firebase removed for diagnostics)");
}

export async function teardownPush(): Promise<void> {
  // no-op
}
