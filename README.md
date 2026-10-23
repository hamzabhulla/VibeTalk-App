# VibeTalk for Android (React Native)

Offline-first Android client for VibeTalk — React Native + WatermelonDB.
Chats live on the device (WhatsApp model): everything works offline,
sending queues locally and syncs through Supabase when online.
Typography and colours match the web app exactly (Manrope).

Login-first: the app opens on the sign-in screen. Tabs: Chats, People,
Calls (native calling is the next milestone), You.

APKs are built by GitHub Actions and published under Releases.

## Build notes (after the audit)

- Debug: `pnpm install && pnpm android` (needs JDK 17, Android SDK 35, NDK 26.1.10909125).
- Release APK is built by `.github/workflows/android.yml`; see `FIXES.md` for the required
  GitHub Secrets and the one-time lockfile refresh.
