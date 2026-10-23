import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { startSync, stopSync, clearSyncState } from "./sync";
import { initCalls, teardownCalls } from "./calls";
import { initPush, teardownPush } from "./push";
import { database } from "../db";

// Boot is idempotent per user: getSession + INITIAL_SESSION both
// fire at startup, and TOKEN_REFRESHED fires hourly/on foreground.
// Re-booting would re-run initCalls (whose teardown kills a live
// call) and stack duplicate push subscribers.
let bootedFor: string | null = null;

function bootUserServices(uid: string, fallbackName: string) {
  if (bootedFor === uid) return;
  bootedFor = uid;
  startSync(uid);
  void initPush(uid);
  // The call engine needs my display name for outgoing invites.
  void supabase
    .from("profiles_public")
    .select("display_name")
    .eq("id", uid)
    .maybeSingle()
    .then(({ data }) => {
      initCalls(uid, (data as any)?.display_name ?? fallbackName);
    })
    .catch(() => {
      // Offline at boot: still bring the call engine up with a fallback name.
      initCalls(uid, fallbackName);
    });
}

type AuthState = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (
    email: string,
    password: string,
    displayName: string,
  ) => Promise<{ error?: string; needsEmailConfirm?: boolean }>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setLoading(false);
      if (data.session) {
        bootUserServices(
          data.session.user.id,
          data.session.user.email?.split("@")[0] ?? "Someone",
        );
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s) {
        // Never call other supabase methods synchronously inside this
        // callback (they wait on the auth lock this callback runs under).
        const uid = s.user.id;
        const fb = s.user.email?.split("@")[0] ?? "Someone";
        setTimeout(() => bootUserServices(uid, fb), 0);
      } else {
        bootedFor = null;
        stopSync();
        teardownCalls();
        void teardownPush();
      }
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn: AuthState["signIn"] = async (email, password) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      return error ? { error: error.message } : {};
    } catch (e: any) {
      return { error: e?.message ?? "Network error - check your connection" };
    }
  };

  const signUp: AuthState["signUp"] = async (email, password, displayName) => {
    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { display_name: displayName.trim() } },
      });
      if (error) return { error: error.message };
      // Supabase hides "already registered" by returning a user with an
      // empty identities list (and no error) when email confirmation is on.
      if (data.user && (data.user.identities?.length ?? 1) === 0) {
        return { error: "This email is already registered. Try signing in." };
      }
      return { needsEmailConfirm: !data.session };
    } catch (e: any) {
      return { error: e?.message ?? "Network error - check your connection" };
    }
  };

  const signOut: AuthState["signOut"] = async () => {
    const uid = session?.user.id ?? null;
    stopSync();
    teardownCalls();
    try {
      await teardownPush();
    } catch {}
    await supabase.auth.signOut();
    // Let the UI unmount the signed-in screens (their DB observers) before
    // the local mirror is wiped.
    await new Promise((r) => setTimeout(r, 150));
    // Offline data belongs to the account - wipe the local mirror so
    // the next account on this device starts clean. The pull watermark
    // must go with it, otherwise the next login would only fetch new
    // messages into an EMPTY database (missing all history).
    try {
      await database.unsafeResetDatabase();
    } catch (e) {
      console.warn("[auth] db reset failed", e);
    }
    await clearSyncState(uid);
  };

  return (
    <Ctx.Provider
      value={{
        user: session?.user ?? null,
        session,
        loading,
        signIn,
        signUp,
        signOut,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
