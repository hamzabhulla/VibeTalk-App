// Runtime configuration that is safe to ship in the client.
//
// TURN: calls only connect across restrictive NATs / mobile carriers
// (CGNAT) when a TURN relay is available. STUN alone works on same Wi-Fi
// and some networks only. Fill these in with your TURN provider
// (coturn, Cloudflare Calls TURN, Metered, Twilio NTS ...). Leave empty
// to keep STUN-only behaviour.
export const TURN = {
  urls: [] as string[], // e.g. ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349?transport=tcp"]
  username: "",
  credential: "",
};

export const STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];
