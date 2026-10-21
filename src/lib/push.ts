import { PermissionsAndroid, Platform } from "react-native";
import messaging from "@react-native-firebase/messaging";
import { supabase } from "./supabase";

// Push notifications (FCM) — client side, complete:
//  - permission (Android 13+ runtime + Firebase) -> token ->
//    registered in `device_push_tokens` (see
//    supabase/device-push-tokens.sql; fail-soft until that table
//    exists, so the app never breaks before the owner runs it).
//  - Delivery itself needs an FCM sender on the server with the
//    Firebase service-account key — a separate server step; the
//    web's push_subscriptions table is Web-Push-only and cannot
//    carry FCM tokens.
//  - Until the real google-services.json replaces the placeholder,
//    Firebase init fails and everything here no-ops quietly.

let registeredUid: string | null = null;
let unsubscribers: (() => void)[] = [];

async function registerToken(uid: string, token: string) {
  const { error } = await supabase.from("device_push_tokens").upsert(
    {
      user_id: uid,
      token,
      platform: "android",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,token" },
  );
  if (error) {
    // Expected until the table exists — never surface to the user.
    console.warn("[push] token register skipped:", error.message);
  }
}

export async function initPush(uid: string): Promise<void> {
  try {
    if (Platform.OS === "android" && Platform.Version >= 33) {
      await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
    }
    const status = await messaging().requestPermission();
    const enabled =
      status === messaging.AuthorizationStatus.AUTHORIZED ||
      status === messaging.AuthorizationStatus.PROVISIONAL;
    if (!enabled) return;
    registeredUid = uid;
    const token = await messaging().getToken();
    if (token) await registerToken(uid, token);
    unsubscribers.push(
      messaging().onTokenRefresh((t) => {
        if (registeredUid) void registerToken(registeredUid, t);
      }),
    );
    unsubscribers.push(
      messaging().onMessage(async () => {
        // Foreground: realtime sync already shows the message/call;
        // a duplicate banner would be noise.
      }),
    );
  } catch (err) {
    console.warn("[push] unavailable (placeholder config?):", err);
  }
}

export async function teardownPush(): Promise<void> {
  for (const off of unsubscribers) {
    try {
      off();
    } catch {
      /* noop */
    }
  }
  unsubscribers = [];
  if (registeredUid) {
    try {
      const token = await messaging().getToken();
      if (token) {
        await supabase
          .from("device_push_tokens")
          .delete()
          .eq("user_id", registeredUid)
          .eq("token", token);
      }
      await messaging().deleteToken();
    } catch {
      /* best-effort */
    }
  }
  registeredUid = null;
}
