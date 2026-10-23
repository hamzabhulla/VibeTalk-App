import "react-native-url-polyfill/auto";
import "react-native-get-random-values";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

// Public values only — the same pair that ships in the web bundle.
// The service-role key NEVER lives in a client app.
const SUPABASE_URL = "https://fkxgyhnivsaijzwpwpjf.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_veGS6f4kS04g6iMGrok7xQ_y7u2tyms";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Supabase's recommended React Native setup: only refresh tokens while the
// app is in the foreground (timers are unreliable in the background).
AppState.addEventListener("change", (state) => {
  if (state === "active") {
    void supabase.auth.startAutoRefresh();
  } else {
    void supabase.auth.stopAutoRefresh();
  }
});
void supabase.auth.startAutoRefresh();
