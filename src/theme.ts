// VibeTalk design tokens — copied 1:1 from the web app
// (hcroom_src: src/components/mobile-shell.tsx MOBILE_CSS vars +
// src/styles.css desktop block + src/lib/avatar-palette.ts).
// If the web palette changes, change it here too.

export const colors = {
  bg: "#F7FAF8", // --bg (mobile)
  surface: "#FFFFFF", // --surface / --card
  ink: "#172B25", // --ink
  foreground: "#14231C", // --card-foreground
  muted: "#788A83", // --muted (text)
  mutedSoft: "#EEF2EF",
  line: "#E6EEE9", // --line
  border: "#DCE5DF", // --border
  green: "#00A651", // --green (brand)
  green2: "#16A34A", // gradient partner / focus rings
  greenDark: "#14532D", // --green-dark
  buttonGreen: "#15803D", // auth primary buttons
  mint: "#DCFCE7", // --mint
  mintPale: "#F0FDF4", // search / chips background
  accent: "#D9EEE4", // --accent
  destructive: "#CA4B55", // mobile destructive
  online: "#22C55E",
  bubbleOther: "#FFFFFF",
  bubbleOwn: "#00A651",
  bubbleOwnText: "#FFFFFF",
  navIdle: "#93A79C",
  timeMuted: "#8FA79C",
};

// Web type scale (Manrope everywhere). RN loads each weight as its
// own family name from assets/fonts (linked via react-native.config.js).
export const font = {
  regular: "Manrope-Regular",
  medium: "Manrope-Medium",
  semibold: "Manrope-SemiBold",
  bold: "Manrope-Bold",
  extrabold: "Manrope-ExtraBold",
} as const;

export function fontForWeight(w: 400 | 500 | 600 | 700 | 800 | 750) {
  switch (w) {
    case 400:
      return font.regular;
    case 500:
      return font.medium;
    case 600:
      return font.semibold;
    case 800:
      return font.extrabold;
    default:
      return font.bold; // 700 + the web's 750
  }
}

export const type = {
  pageTitle: { fontFamily: font.bold, fontSize: 24, letterSpacing: -0.65 },
  sectionTitle: { fontFamily: font.bold, fontSize: 23, letterSpacing: -0.6 },
  kicker: {
    fontFamily: font.extrabold,
    fontSize: 9,
    letterSpacing: 1.8,
    color: colors.green,
  },
  roomName: { fontFamily: font.bold, fontSize: 15.5, color: colors.ink },
  preview: { fontFamily: font.medium, fontSize: 13, color: colors.muted },
  body: { fontFamily: font.regular, fontSize: 14.5, color: colors.ink },
  caption: { fontFamily: font.medium, fontSize: 11.5, color: colors.timeMuted },
} as const;

// src/lib/avatar-palette.ts (web) — same hash, same pairs, so a person
// keeps their colour across web and app.
export const AV_PALETTES = [
  { bg: "#FDEEDA", fg: "#B45309" },
  { bg: "#E3E9FD", fg: "#3B4BA8" },
  { bg: "#E7E2F5", fg: "#6D4FA1" },
  { bg: "#FDE2E2", fg: "#B91C1C" },
  { bg: "#DCEFE2", fg: "#15803D" },
] as const;

export function paletteFor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AV_PALETTES[h % AV_PALETTES.length];
}

// Same letters-only initials as the web's src/lib/initials.ts.
export function initialsOf(name: string | null | undefined): string {
  if (!name) return "?";
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}]+/u, ""))
    .filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return "?";
  const first = [...words[0]][0];
  if (words.length === 1) return first.toUpperCase();
  const last = [...words[words.length - 1]][0];
  return (first + last).toUpperCase();
}
