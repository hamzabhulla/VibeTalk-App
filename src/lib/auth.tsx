import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { startSync, stopSync } from "./sync";
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
        bootUserServices(s.user.id, s.user.email?.split("@")[0] ?? "Someone");
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
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    return error ? { error: error.message } : {};
  };

  const signUp: AuthState["signUp"] = async (email, password, displayName) => {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { display_name: displayName.trim() } },
    });
    if (error) return { error: error.message };
    return { needsEmailConfirm: !data.session };
  };

  const signOut: AuthState["signOut"] = async () => {
    stopSync();
    teardownCalls();
    await teardownPush();
    await supabase.auth.signOut();
    // Offline data belongs to the account — wipe the local mirror so
    // the next account on this device starts clean.
    await database.unsafeResetDatabase();
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
