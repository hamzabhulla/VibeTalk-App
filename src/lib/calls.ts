import { PermissionsAndroid, Platform, Vibration } from "react-native";
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
  type MediaStream,
} from "react-native-webrtc";
import InCallManager from "react-native-incall-manager";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import {
  computeSignalMac,
  verifySignalMac,
  generateCallSecret,
} from "./callCrypto";
import { sendCallMessage } from "./sync";
import { uuidv4 } from "./uuid";
import { STUN_URLS, TURN } from "../config";

// Voice/video calls — the web app's protocol, ported:
//  - All signaling rides Supabase Realtime broadcast event
//    "call-signal" on the RECIPIENT's personal channel `call:<userId>`.
//  - Signal shapes are the web's CallSignal union (invite / accept /
//    decline / offer / answer / ice / end / offer-request).
//  - offer/answer/ice are HMAC-SHA256-signed with a per-call secret
//    (see callCrypto.ts — byte-identical to the web's scheme).
//  - The invite row (call_invites) is created by the WEB server only:
//    direct client inserts were removed server-side (audit-2 H33),
//    so a mobile-originated call has no row. Interop matrix:
//      web -> mobile : full (row + secret fetched by participants)
//      mobile -> mobile : works — the invite carries the secret
//        (field `msecret`, ignored by web) so MACs still verify;
//        treat as the web's own "degraded" mode, minus the server
//        gate.
//      mobile -> web : the web client verifies invites against the
//        server row and fails closed without one, so the web side
//        will not ring until a server invite path exists for
//        mobile. Known gap, reported to the owner.

export type CallType = "voice" | "video";
export type CallPhase =
  | "idle"
  | "outgoing"
  | "incoming"
  | "connecting"
  | "in-call"
  | "ended";

export type CallState = {
  phase: CallPhase;
  callId: string | null;
  peerId: string | null;
  peerName: string | null;
  type: CallType;
  direction: "incoming" | "outgoing" | null;
  roomId: string | null;
  connectedAt: number | null;
  muted: boolean;
  videoOff: boolean;
  speakerOn: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  degraded: boolean;
};

const IDLE: CallState = {
  phase: "idle",
  callId: null,
  peerId: null,
  peerName: null,
  type: "voice",
  direction: null,
  roomId: null,
  connectedAt: null,
  muted: false,
  videoOff: false,
  speakerOn: false,
  localStream: null,
  remoteStream: null,
  degraded: false,
};

// STUN alone only connects on friendly networks. Behind mobile-carrier
// CGNAT / symmetric NAT a TURN relay is required - configure it in
// src/config.ts (left empty by default: STUN-only, same as before).
const ICE_SERVERS: any[] = [
  { urls: STUN_URLS },
  ...(TURN.urls.length
    ? [{ urls: TURN.urls, username: TURN.username, credential: TURN.credential }]
    : []),
];
const RING_TIMEOUT_MS = 30_000;

let state: CallState = { ...IDLE };
const listeners = new Set<() => void>();
let myId: string | null = null;
let myName = "Someone";
let ownChannel: RealtimeChannel | null = null;
const peerChannels = new Map<string, Promise<RealtimeChannel>>();
let pc: RTCPeerConnection | null = null;
let secret: string | null = null;
let ringTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCandidates: any[] = [];
let bufferedOffer: any | null = null;
let lastOfferSent: any | null = null;
let lastOfferResentAt = 0;
let outcomePosted = false;
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
const DISCONNECT_GRACE_MS = 8_000;

function clearDisconnectTimer() {
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }
}

export function getCallState() {
  return state;
}

export function onCallStateChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setState(patch: Partial<CallState>) {
  state = { ...state, ...patch };
  for (const fn of [...listeners]) fn();
}

async function ensurePermissions(video: boolean): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const perms: string[] = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  if (video) perms.push(PermissionsAndroid.PERMISSIONS.CAMERA);
  const res = await PermissionsAndroid.requestMultiple(perms as any);
  return perms.every(
    (p) => (res as any)[p] === PermissionsAndroid.RESULTS.GRANTED,
  );
}

const CHANNEL_JOIN_TIMEOUT_MS = 8_000;

function peerChannel(peerId: string): Promise<RealtimeChannel> {
  let p = peerChannels.get(peerId);
  if (!p) {
    p = new Promise<RealtimeChannel>((resolve, reject) => {
      const ch = supabase.channel(`call:${peerId}`);
      let settled = false;
      const drop = () => {
        peerChannels.delete(peerId);
        void supabase.removeChannel(ch);
      };
      // A subscribe that never completes used to hang the call forever
      // (and the dead promise stayed cached). Time out, evict, reject.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        drop();
        reject(new Error("call channel join timed out"));
      }, CHANNEL_JOIN_TIMEOUT_MS);
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(ch);
          }
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(new Error(`call channel ${status}`));
          }
          drop(); // never keep a dead channel in the cache
        }
      });
    });
    peerChannels.set(peerId, p);
    p.catch(() => peerChannels.delete(peerId));
  }
  return p;
}

/** Never throws: returns whether the signal was actually delivered to the
 *  realtime server (supabase's send() reports failure as a string). */
async function sendSignal(
  peerId: string,
  signal: Record<string, unknown>,
): Promise<boolean> {
  try {
    const ch = await peerChannel(peerId);
    const res = await ch.send({
      type: "broadcast",
      event: "call-signal",
      payload: signal,
    });
    return res === "ok";
  } catch (e: any) {
    console.warn("[calls] signal failed:", e?.message ?? e);
    return false;
  }
}

async function fetchInviteRow(
  callId: string,
): Promise<{ secret: string | null; callerName: string | null } | null> {
  const { data } = await supabase
    .from("call_invites")
    .select("secret, caller_name, status")
    .eq("id", callId)
    .maybeSingle();
  if (!data) return null;
  return {
    secret: (data as any).secret ?? null,
    callerName: (data as any).caller_name ?? null,
  };
}

// Trust gate for row-less invites: do I share any room with this
// user? (Two-step lookup — my rooms, then their membership in them.)
async function sharesRoomWith(otherId: string): Promise<boolean> {
  const { data: mine } = await supabase
    .from("room_members")
    .select("room_id")
    .eq("user_id", myId);
  const ids = (mine ?? []).map((r: any) => r.room_id as string);
  if (ids.length === 0) return false;
  const { data: theirs } = await supabase
    .from("room_members")
    .select("room_id")
    .eq("user_id", otherId)
    .in("room_id", ids)
    .limit(1);
  return !!theirs && theirs.length > 0;
}

// Display name from the visibility-gated public record — never
// from the signal's self-claimed name.
async function displayNameFor(uid: string): Promise<string | null> {
  const { data } = await supabase
    .from("profiles_public")
    .select("display_name")
    .eq("id", uid)
    .maybeSingle();
  return (data as any)?.display_name ?? null;
}

async function updateInviteStatus(callId: string, status: string) {
  await supabase
    .from("call_invites")
    .update({ status })
    .eq("id", callId)
    .then(({ error }) => {
      if (error) console.warn("[calls] invite status:", error.message);
    });
}

function clearRingTimer() {
  if (ringTimer) {
    clearTimeout(ringTimer);
    ringTimer = null;
  }
}

function closePc() {
  if (pc) {
    try {
      pc.close();
    } catch {
      /* already closed */
    }
    pc = null;
  }
  pendingCandidates = [];
  bufferedOffer = null;
  lastOfferSent = null;
}

function stopLocalMedia() {
  state.localStream?.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      /* noop */
    }
  });
}

function cleanupToIdle() {
  clearRingTimer();
  clearDisconnectTimer();
  Vibration.cancel();
  closePc();
  stopLocalMedia();
  try {
    InCallManager.stop();
  } catch {
    /* not started */
  }
  secret = null;
  outcomePosted = false;
  setState({ ...IDLE });
}

/** Post the WhatsApp-style call entry into the chat (caller only,
 *  web wire shape: body JSON { call, status, duration }). */
function postOutcome(status: string, durationSec: number) {
  if (outcomePosted) return;
  outcomePosted = true;
  if (
    state.direction === "outgoing" &&
    state.roomId &&
    myId &&
    state.peerId
  ) {
    void sendCallMessage(myId, state.roomId, {
      type: state.type,
      status: status as any,
      duration: durationSec,
    });
  }
}

function durationSeconds(): number {
  return state.connectedAt
    ? Math.max(0, Math.round((Date.now() - state.connectedAt) / 1000))
    : 0;
}

function buildPeer(): RTCPeerConnection {
  const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  (peer as any).onicecandidate = (e: any) => {
    if (e.candidate && state.peerId && state.callId) {
      const cand = {
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
      };
      const signal: Record<string, unknown> = {
        kind: "ice",
        callId: state.callId,
        from: myId,
        candidate: cand,
      };
      if (secret) signal.mac = computeSignalMac(secret, "ice", state.callId, cand);
      void sendSignal(state.peerId, signal);
    }
  };
  (peer as any).ontrack = (e: any) => {
    if (e.streams?.[0]) setState({ remoteStream: e.streams[0] });
  };
  (peer as any).onconnectionstatechange = () => {
    const cs = (peer as any).connectionState;
    if (cs === "connected") {
      clearRingTimer();
      clearDisconnectTimer();
      setState({
        phase: "in-call",
        connectedAt: state.connectedAt ?? Date.now(),
      });
    } else if (cs === "disconnected") {
      // "disconnected" is usually a brief network blip (Wi-Fi <-> 4G
      // handover, a tunnel...) that WebRTC recovers from on its own.
      // Only give up if it does not come back within the grace period.
      if (
        !disconnectTimer &&
        (state.phase === "in-call" || state.phase === "connecting")
      ) {
        disconnectTimer = setTimeout(() => {
          disconnectTimer = null;
          if (
            (peer as any).connectionState !== "connected" &&
            (state.phase === "in-call" || state.phase === "connecting")
          ) {
            postOutcome(
              state.connectedAt ? "completed" : "failed",
              durationSeconds(),
            );
            cleanupToIdle();
          }
        }, DISCONNECT_GRACE_MS);
      }
    } else if (cs === "failed" || cs === "closed") {
      clearDisconnectTimer();
      if (state.phase === "in-call" || state.phase === "connecting") {
        postOutcome(state.connectedAt ? "completed" : "failed", durationSeconds());
        cleanupToIdle();
      }
    }
  };
  (peer as any).onnegotiationneeded = async () => {
    // Mid-call renegotiation (video upgrade). Only the side that
    // added tracks initiates; offers are MAC'd like the first one.
    if (!state.callId || !state.peerId || state.phase !== "in-call") return;
    try {
      const offer = await peer.createOffer({});
      await peer.setLocalDescription(offer);
      const sdp = { type: offer.type, sdp: offer.sdp };
      const signal: Record<string, unknown> = {
        kind: "offer",
        callId: state.callId,
        from: myId,
        sdp,
        type: state.type,
      };
      if (secret) signal.mac = computeSignalMac(secret, "offer", state.callId, sdp);
      lastOfferSent = signal;
      await sendSignal(state.peerId, signal);
    } catch (err) {
      console.warn("[calls] renegotiation failed:", err);
    }
  };
  return peer;
}

async function getMedia(type: CallType): Promise<MediaStream> {
  return (await mediaDevices.getUserMedia({
    audio: true,
    video:
      type === "video"
        ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }
        : false,
  } as any)) as MediaStream;
}

function attachLocal(stream: MediaStream) {
  setState({ localStream: stream });
  if (pc) {
    for (const track of stream.getTracks() as any[]) pc.addTrack(track, stream);
  }
}

function verifyOrDegraded(
  kind: "offer" | "answer" | "ice",
  payload: unknown,
  mac: string | undefined,
  callId: string,
): boolean {
  if (!secret) return state.degraded; // no secret exists for this call
  return verifySignalMac(secret, kind, callId, payload, mac);
}

async function handleOffer(sig: any) {
  if (!verifyOrDegraded("offer", sig.sdp, sig.mac, sig.callId)) {
    console.warn("[calls] offer rejected: bad MAC");
    return;
  }
  if (!pc) {
    // Callee accepted before the offer arrived (or it raced the
    // invite) — buffer until accept() builds the peer.
    bufferedOffer = sig;
    return;
  }
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
    for (const c of pendingCandidates) {
      await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    }
    pendingCandidates = [];
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const sdp = { type: answer.type, sdp: answer.sdp };
    const signal: Record<string, unknown> = {
      kind: "answer",
      callId: sig.callId,
      from: myId,
      sdp,
      type: state.type,
    };
    if (secret) signal.mac = computeSignalMac(secret, "answer", sig.callId, sdp);
    await sendSignal(sig.from, signal);
    setState({ phase: "connecting" });
  } catch (err) {
    console.warn("[calls] answer failed:", err);
  }
}

async function handleSignal(sig: any) {
  if (!sig || sig.from === myId) return;
  switch (sig.kind) {
    case "invite": {
      const row = await fetchInviteRow(sig.callId);
      // Trust gate: a server row is authoritative (the web's server
      // fn validated membership when creating it). A row-less invite
      // rings ONLY from someone I share a room with, and the shown
      // name then comes from their public profile record — user ids
      // are enumerable, so an arbitrary stranger must not be able
      // to ring this phone or spoof a contact's name. (Residual,
      // owner's call: degraded mode's unsigned media signaling is
      // thereby limited to people who could message me anyway, vs
      // the web's strict row-only rule.)
      let peerName = row?.callerName ?? null;
      if (!row) {
        if (!(await sharesRoomWith(sig.from))) return;
        peerName = await displayNameFor(sig.from);
      }
      if (state.phase !== "idle") {
        // Busy: decline only VERIFIED invites (web parity) — an
        // unverified decline leaks live busy status to strangers.
        void sendSignal(sig.from, {
          kind: "decline",
          callId: sig.callId,
          from: myId,
        });
        return;
      }
      secret = row?.secret ?? sig.msecret ?? null;
      setState({
        phase: "incoming",
        callId: sig.callId,
        peerId: sig.from,
        peerName: peerName ?? "Someone",
        type: sig.type === "video" ? "video" : "voice",
        direction: "incoming",
        roomId: null,
        degraded: !row,
        connectedAt: null,
      });
      Vibration.vibrate([0, 500, 300, 500]);
      ringTimer = setTimeout(() => {
        if (state.phase === "incoming") cleanupToIdle(); // missed
      }, RING_TIMEOUT_MS);
      return;
    }
    case "accept": {
      if (state.callId !== sig.callId || state.phase !== "outgoing") return;
      clearRingTimer();
      setState({ phase: "connecting" });
      if (!pc) pc = buildPeer();
      if (state.localStream && !(pc as any)._vtAttached) {
        attachLocal(state.localStream);
        (pc as any)._vtAttached = true;
      }
      try {
        const offer = await pc.createOffer({});
        await pc.setLocalDescription(offer);
        const sdp = { type: offer.type, sdp: offer.sdp };
        const signal: Record<string, unknown> = {
          kind: "offer",
          callId: sig.callId,
          from: myId,
          sdp,
          type: state.type,
        };
        if (secret) signal.mac = computeSignalMac(secret, "offer", sig.callId, sdp);
        lastOfferSent = signal;
        await sendSignal(sig.from, signal);
      } catch (err) {
        console.warn("[calls] offer failed:", err);
      }
      return;
    }
    case "decline": {
      if (state.callId !== sig.callId) return;
      postOutcome("declined", 0);
      cleanupToIdle();
      return;
    }
    case "offer": {
      if (state.callId !== sig.callId) return;
      if (sig.type === "video" || sig.type === "voice") {
        setState({ type: sig.type });
      }
      await handleOffer(sig);
      return;
    }
    case "answer": {
      if (state.callId !== sig.callId || !pc) return;
      if (!verifyOrDegraded("answer", sig.sdp, sig.mac, sig.callId)) {
        console.warn("[calls] answer rejected: bad MAC");
        return;
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
        for (const c of pendingCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
        pendingCandidates = [];
      } catch (err) {
        console.warn("[calls] setRemote(answer) failed:", err);
      }
      return;
    }
    case "ice": {
      if (state.callId !== sig.callId) return;
      if (!verifyOrDegraded("ice", sig.candidate, sig.mac, sig.callId)) return;
      if (pc && (pc as any).remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(() => {});
      } else if (pendingCandidates.length < 50) {
        pendingCandidates.push(sig.candidate);
      }
      return;
    }
    case "offer-request": {
      // Callee reconstructed ringing from the persisted invite and
      // asks for the offer again (web flow). 5s resend cooldown
      // (web audit-5 B3) so a spamming peer can't make us flood.
      if (state.callId === sig.callId && lastOfferSent && state.peerId) {
        const now = Date.now();
        if (now - lastOfferResentAt < 5000) return;
        lastOfferResentAt = now;
        await sendSignal(state.peerId, lastOfferSent);
      }
      return;
    }
    case "end": {
      if (state.callId !== sig.callId) return;
      postOutcome(
        state.connectedAt
          ? "completed"
          : (sig as any).reason === "cancelled"
            ? "cancelled"
            : "missed",
        durationSeconds(),
      );
      cleanupToIdle();
      return;
    }
  }
}

export async function initCalls(uid: string, displayName: string) {
  teardownCalls();
  myId = uid;
  myName = displayName || "Someone";
  ownChannel = supabase
    .channel(`call:${uid}`)
    .on("broadcast", { event: "call-signal" }, (msg) => {
      void handleSignal(msg.payload);
    })
    .subscribe();
  // Recover a still-ringing invite that arrived while the app was
  // closed (web parity: pending-invite recovery on mount).
  const since = new Date(Date.now() - 90_000).toISOString();
  const { data } = await supabase
    .from("call_invites")
    .select("id, caller_id, caller_name, type, secret")
    .eq("callee_id", uid)
    .eq("status", "ringing")
    .gt("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  const inv = (data ?? [])[0] as any;
  if (inv && state.phase === "idle") {
    secret = inv.secret ?? null;
    setState({
      phase: "incoming",
      callId: inv.id,
      peerId: inv.caller_id,
      peerName: inv.caller_name ?? "Someone",
      type: inv.type === "video" ? "video" : "voice",
      direction: "incoming",
      roomId: null,
      degraded: false,
      connectedAt: null,
    });
    Vibration.vibrate([0, 500, 300, 500]);
    ringTimer = setTimeout(() => {
      if (state.phase === "incoming") cleanupToIdle();
    }, RING_TIMEOUT_MS);
  }
}

export function teardownCalls() {
  cleanupToIdle();
  if (ownChannel) {
    void supabase.removeChannel(ownChannel);
    ownChannel = null;
  }
  for (const p of peerChannels.values()) {
    void p.then((ch) => supabase.removeChannel(ch));
  }
  peerChannels.clear();
  myId = null;
}

export async function startCall(
  peerId: string,
  peerName: string,
  type: CallType,
  roomId?: string,
): Promise<boolean> {
  if (!myId || state.phase !== "idle") return false;
  if (!(await ensurePermissions(type === "video"))) return false;
  const callId = uuidv4();
  secret = generateCallSecret();
  setState({
    phase: "outgoing",
    callId,
    peerId,
    peerName,
    type,
    direction: "outgoing",
    roomId: roomId ?? null,
    degraded: true, // no server row for mobile-originated calls
    connectedAt: null,
    muted: false,
    speakerOn: type === "video",
  });
  try {
    const stream = await getMedia(type);
    setState({ localStream: stream });
    pc = buildPeer();
    attachLocal(stream);
    (pc as any)._vtAttached = true;
    try {
      InCallManager.start({ media: type === "video" ? "video" : "audio" });
      InCallManager.setForceSpeakerphoneOn(type === "video");
    } catch {
      /* best-effort */
    }
  } catch (err) {
    console.warn("[calls] getUserMedia failed:", err);
    cleanupToIdle();
    return false;
  }
  const invited = await sendSignal(peerId, {
    kind: "invite",
    callId,
    from: myId,
    fromName: myName,
    type,
    // Mobile-originated calls have no server row; the callee (mobile)
    // uses this to verify MACs. Web callees ignore it (and require
    // the row, so they will not ring — see the header note).
    msecret: secret,
  });
  if (!invited) {
    // Could not reach the realtime server: do not sit in "calling..." for
    // 30 seconds pretending the other side is being rung.
    postOutcome("failed", 0);
    cleanupToIdle();
    return false;
  }
  ringTimer = setTimeout(() => {
    if (state.phase === "outgoing" && state.peerId) {
      void sendSignal(state.peerId, {
        kind: "end",
        callId: state.callId,
        from: myId,
      });
      postOutcome("missed", 0);
      cleanupToIdle();
    }
  }, RING_TIMEOUT_MS);
  return true;
}

export async function acceptCall(): Promise<void> {
  if (state.phase !== "incoming" || !state.callId || !state.peerId) return;
  if (!(await ensurePermissions(state.type === "video"))) {
    await declineCall();
    return;
  }
  clearRingTimer();
  Vibration.cancel();
  const { callId, peerId } = state;
  setState({ phase: "connecting" });
  pc = buildPeer();
  try {
    const stream = await getMedia(state.type);
    attachLocal(stream);
    (pc as any)._vtAttached = true;
    try {
      InCallManager.start({ media: state.type === "video" ? "video" : "audio" });
      InCallManager.setForceSpeakerphoneOn(state.type === "video");
    } catch {
      /* best-effort */
    }
  } catch (err) {
    console.warn("[calls] getUserMedia failed:", err);
    cleanupToIdle();
    return;
  }
  void updateInviteStatus(callId, "accepted");
  if (!(await sendSignal(peerId, { kind: "accept", callId, from: myId }))) {
    cleanupToIdle();
    return;
  }
  // If the caller already sent its offer, answer it now; if it does
  // not arrive shortly, ask for a re-send (web's offer-request).
  if (bufferedOffer) {
    const offer = bufferedOffer;
    bufferedOffer = null;
    await handleOffer(offer);
  } else {
    setTimeout(() => {
      if (state.phase === "connecting" && state.callId === callId && !pc?.remoteDescription) {
        void sendSignal(peerId, {
          kind: "offer-request",
          callId,
          from: myId,
        });
      }
    }, 2500);
  }
}

export async function declineCall(): Promise<void> {
  if (!state.callId || !state.peerId) return;
  const { callId, peerId } = state;
  void updateInviteStatus(callId, "declined");
  await sendSignal(peerId, { kind: "decline", callId, from: myId });
  cleanupToIdle();
}

export async function endCall(): Promise<void> {
  if (!state.callId || !state.peerId) {
    cleanupToIdle();
    return;
  }
  const { callId, peerId } = state;
  const wasConnected = !!state.connectedAt;
  const wasOutgoing = state.direction === "outgoing";
  void updateInviteStatus(callId, "ended");
  await sendSignal(peerId, {
    kind: "end",
    callId,
    from: myId,
    ...(!wasConnected && wasOutgoing ? { reason: "cancelled" } : {}),
  });
  postOutcome(wasConnected ? "completed" : "cancelled", durationSeconds());
  cleanupToIdle();
}

export function toggleMute() {
  const next = !state.muted;
  state.localStream?.getAudioTracks().forEach((t) => {
    t.enabled = !next;
  });
  setState({ muted: next });
}

export function toggleVideo() {
  const next = !state.videoOff;
  state.localStream?.getVideoTracks().forEach((t) => {
    t.enabled = !next;
  });
  setState({ videoOff: next });
}

export function toggleSpeaker() {
  const next = !state.speakerOn;
  try {
    InCallManager.setForceSpeakerphoneOn(next);
  } catch {
    /* best-effort */
  }
  setState({ speakerOn: next });
}

export function switchCamera() {
  const track: any = state.localStream?.getVideoTracks()[0];
  if (track && typeof track._switchCamera === "function") {
    track._switchCamera();
  }
}

export async function upgradeToVideo(): Promise<void> {
  if (state.phase !== "in-call" || state.type === "video" || !pc) return;
  if (!(await ensurePermissions(true))) return;
  try {
    const stream = await getMedia("video");
    const videoTrack: any = stream.getVideoTracks()[0];
    // The temp stream's mic track is a duplicate capture — stop it.
    // The video track joins the EXISTING local stream so the audio
    // track (and mute) stays the very one the peer connection holds.
    stream.getAudioTracks().forEach((t) => t.stop());
    if (videoTrack && state.localStream) {
      pc.addTrack(videoTrack, state.localStream);
      (state.localStream as any).addTrack?.(videoTrack);
      setState({ type: "video", localStream: state.localStream });
    } else if (videoTrack) {
      pc.addTrack(videoTrack, stream);
      setState({ type: "video", localStream: stream });
    }
  } catch (err) {
    console.warn("[calls] video upgrade failed:", err);
  }
}
