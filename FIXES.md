# VibeTalk – audit fixes

Sab changes is zip mein already apply hain. Neeche list hai ke kya badla aur
kya **aap ko khud karna hai** (kyunke code se nahi ho sakta).

## Aap ko karna hai (zaroori)

1. **Lockfile refresh (1 baar):** `pnpm install` chalao aur `pnpm-lock.yaml` commit karo.
   (Jab tak commit nahi hota, CI `--no-frozen-lockfile` se khud resolve kar leta hai.)
2. **Release keystore GitHub Secrets mein daalo**, phir `android/keystore.b64` repo se hata do:
   - `ANDROID_KEYSTORE_BASE64` = keystore file ka base64
   - `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
   - `git rm android/keystore.b64 android/app/google-services.json*` aur commit.
   - Agar repo kabhi public/shared raha hai, to us keystore ko **compromised** samjho
     (naya key banao; Play App Signing use karo to upload key reset ho sakti hai).
3. **TURN server** (mobile data par calls ke liye): `src/config.ts` mein `TURN` bharo
   (coturn / Cloudflare / Metered / Twilio). Khali chhorne par STUN-only rehta hai.
4. Real logo: `assets/logo-mark.png` abhi placeholder hai. CI worker se asli logo laata
   rehta hai; local ke liye apna logo is path par rakh do (aur launcher icons regenerate karo).
5. Fonts: `assets/fonts/Manrope-*.ttf` commit kar do (CI download sirf refresh karta hai,
   fail ho to build nahi tootta).
6. Local build ke liye: `cd android && gradle wrapper --gradle-version 8.10.2`
   (gradle-wrapper.jar repo mein nahi tha) ya Android Studio se sync karo.

## Build fixes

| Problem | Fix |
|---|---|
| `@babel/plugin-proposal-decorators@8` + `@babel/core@7` (Node 22+ only) | `^7.25.0` pin; `@babel/plugin-transform-class-properties` explicitly declared |
| CI installed `android-36` + NDK 27.1, project needs 35 / 26.1.10909125 | workflow ab `platforms;android-35 build-tools;35.0.0 ndk;26.1.10909125 cmake;3.22.1` |
| `assets/` + mipmap icons repo mein nahi the; CI downloads fail = build fail | assets + icons committed; downloads best-effort |
| `debug.keystore` missing (debug build fail) | generate + commit; Gradle ab uske bina bhi chalta hai |
| Release signing env missing = fail | env na ho to debug key se sign (warning) |
| Real release keystore repo mein | removed from zip; CI ab `ANDROID_KEYSTORE_BASE64` secret use karta hai |
| Stale `google-services.json` placeholder | removed |
| Gradle heap 2 GB | 4 GB |
| `App.test.tsx` mocks ke bina fail | replaced with real unit tests (HMAC vector, uuid, base64url) |

## Runtime bug fixes

- `crypto.randomUUID()` (Hermes mein nahi) → `src/lib/uuid.ts` (text/media send, calls).
- People tab khali rehta tha (profiles sirf existing rooms ke members ki) → directory ab rooms se pehle fetch hoti hai.
- Android `Alert` max 3 buttons → reaction/edit/delete ab proper bottom-sheet modal.
- Call buttons nahi dikhte the (custom header) → `ChatHeader` component, safe-area aware.
- Offline send ab `failed` nahi hota: network errors par pending rehta hai; mutex; auto-retry har 30s + reconnect.
- Unread badge: receipts se derive hota hai (band app mein aaye messages bhi), double-count nahi; open chat mein incoming = auto read receipt.
- Background→foreground aur realtime reconnect par catch-up; naye rooms (kisi ne DM kiya) auto-resync.
- `upsertById` race (UNIQUE error) → writer ke andar atomic + batched.
- Pull performance: har message ke ~4 writes → page-wise single batch; room-id filters chunked (URL length).
- File upload: `fetch().arrayBuffer()` (RN mein unsupported) → FormData.
- Sign-out: pull watermark + in-memory state clear (pehle dobara login par history gayab).
- Supabase: AppState-based token refresh; auth callback mein deadlock-safe boot; "already registered" detection.
- Calls: TURN config, `disconnected` par 8s grace, signaling timeout/never-throw, failed invite = turant fail, Calls tab local history se (mobile calls bhi dikhti hain, offline bhi).
- E2EE: member-key lookup fail = retry (pehle undecryptable envelope), sender hamesha recipient, noble-curves 1.x/2.x API tolerant.
- Voice: pause→resume (restart nahi), expired signed URL, 0-second recording send nahi, screen chhodne par recording stop.
- Chat: message list pagination (60), sirf visible messages ki reactions observe, file attachment tap se khulta hai, draft send fail par wapas aata hai.
- UI: tab bar + chat header safe-area, tabPress events, pull-to-refresh on Chats.

## Jo main nahi kar saka (backend / native / aap ka faisla)

- **Push notifications / ringing jab app band ho:** real Firebase project + `google-services.json` + FCM server chahiye (`push.ts` stub hai).
- **Background mein call (mic):** Android foreground service (native Kotlin) chahiye.
- **Call signaling security:** `msecret` usi public broadcast channel par jata hai; asli fix = Supabase *private* channels + RLS ya server-side invite rows.
- **E2EE private key AsyncStorage mein hai:** `react-native-keychain` jaisa Keystore-backed storage chahiye (naya native dependency – is liye jaan-boojh kar nahi joda, build na tootne ke liye).
- **Naye device par E2EE key overwrite:** web ke saath same single-key design; fix ke liye multi-device key transfer chahiye.
- **Google Play:** account deletion (in-app + web link) required; targetSdk/policy dates check karo.
