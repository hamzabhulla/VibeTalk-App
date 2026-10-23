import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Modal } from "react-native";
import { RTCView } from "react-native-webrtc";
import {
  PhoneOff,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Volume2,
  SwitchCamera,
  PhoneIncoming,
} from "lucide-react-native";
import {
  getCallState,
  onCallStateChange,
  acceptCall,
  declineCall,
  endCall,
  toggleMute,
  toggleVideo,
  toggleSpeaker,
  switchCamera,
  upgradeToVideo,
  type CallState,
} from "../lib/calls";
import { Avatar } from "./Avatar";
import { colors, font } from "../theme";

function useCall(): CallState {
  const [, setTick] = useState(0);
  useEffect(() => onCallStateChange(() => setTick((t) => t + 1)), []);
  return getCallState();
}

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Global call UI: incoming ring, outgoing, and in-call screens. */
export function CallOverlay() {
  const call = useCall();
  const [, setSec] = useState(0);
  useEffect(() => {
    if (!call.connectedAt) return;
    const iv = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [call.connectedAt]);

  if (call.phase === "idle" || call.phase === "ended") return null;
  const inCall = call.phase === "in-call";
  const dur = call.connectedAt
    ? Math.max(0, Math.floor((Date.now() - call.connectedAt) / 1000))
    : 0;
  const statusText =
    call.phase === "incoming"
      ? `Incoming ${call.type} call…`
      : call.phase === "outgoing"
        ? "Calling…"
        : call.phase === "connecting"
          ? "Connecting…"
          : fmt(dur);

  return (
    <Modal visible transparent={false} animationType="slide">
      <View style={styles.root}>
        {call.type === "video" && call.remoteStream && (
          <RTCView
            streamURL={(call.remoteStream as any).toURL()}
            style={styles.remoteVideo}
            objectFit="cover"
          />
        )}
        {call.type === "video" && call.localStream && (
          <RTCView
            streamURL={(call.localStream as any).toURL()}
            style={styles.localVideo}
            objectFit="cover"
            zOrder={1}
          />
        )}
        <View style={styles.head}>
          <Avatar name={call.peerName ?? "Someone"} size={86} />
          <Text style={styles.name}>{call.peerName ?? "Someone"}</Text>
          <Text style={styles.status}>{statusText}</Text>
          {call.degraded && (
            <Text style={styles.degraded}>
              Unverified connection (no server invite)
            </Text>
          )}
        </View>

        {call.phase === "incoming" ? (
          <View style={styles.actions}>
            <View style={styles.actionCol}>
              <TouchableOpacity
                style={[styles.roundBtn, styles.declineBtn]}
                onPress={() => void declineCall()}
              >
                <PhoneOff size={26} color="#fff" />
              </TouchableOpacity>
              <Text style={styles.actionLabel}>Decline</Text>
            </View>
            <View style={styles.actionCol}>
              <TouchableOpacity
                style={[styles.roundBtn, styles.acceptBtn]}
                onPress={() => void acceptCall()}
              >
                <PhoneIncoming size={26} color="#fff" />
              </TouchableOpacity>
              <Text style={styles.actionLabel}>Accept</Text>
            </View>
          </View>
        ) : (
          <View style={styles.controlsWrap}>
            <View style={styles.controls}>
              <TouchableOpacity
                style={[styles.ctrlBtn, call.muted && styles.ctrlBtnOn]}
                onPress={toggleMute}
              >
                {call.muted ? (
                  <MicOff size={21} color="#fff" />
                ) : (
                  <Mic size={21} color="#fff" />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.ctrlBtn, call.speakerOn && styles.ctrlBtnOn]}
                onPress={toggleSpeaker}
              >
                <Volume2 size={21} color="#fff" />
              </TouchableOpacity>
              {call.type === "video" ? (
                <TouchableOpacity style={styles.ctrlBtn} onPress={switchCamera}>
                  <SwitchCamera size={21} color="#fff" />
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={styles.ctrlBtn}
                  onPress={() => void upgradeToVideo()}
                >
                  <Video size={21} color="#fff" />
                </TouchableOpacity>
              )}
              {call.type === "video" && (
                <TouchableOpacity
                  style={styles.ctrlBtn}
                  onPress={toggleVideo}
                >
                  {call.videoOff ? (
                    <Video size={21} color="#fff" />
                  ) : (
                    <VideoOff size={21} color="#fff" />
                  )}
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity
              style={[styles.roundBtn, styles.declineBtn, { alignSelf: "center" }]}
              onPress={() => void endCall()}
            >
              <PhoneOff size={26} color="#fff" />
            </TouchableOpacity>
            {!inCall && <Text style={styles.hint}>End call</Text>}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0E241C",
    justifyContent: "space-between",
    paddingVertical: 70,
  },
  remoteVideo: { ...StyleSheet.absoluteFillObject, backgroundColor: "#000" },
  localVideo: {
    position: "absolute",
    top: 56,
    right: 18,
    width: 108,
    height: 152,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#1d3a2f",
  },
  head: { alignItems: "center", gap: 9, paddingHorizontal: 24 },
  name: {
    fontFamily: font.extrabold,
    fontSize: 25,
    color: "#fff",
    textAlign: "center",
  },
  status: { fontFamily: font.medium, fontSize: 15, color: "#BFE9CF" },
  degraded: { fontFamily: font.regular, fontSize: 11.5, color: "#E8C87A" },
  actions: {
    flexDirection: "row",
    justifyContent: "space-evenly",
    paddingHorizontal: 30,
  },
  actionCol: { alignItems: "center", gap: 8 },
  actionLabel: { fontFamily: font.medium, fontSize: 13, color: "#DFF5E6" },
  roundBtn: {
    width: 68,
    height: 68,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  declineBtn: { backgroundColor: "#D64550" },
  acceptBtn: { backgroundColor: colors.green },
  controlsWrap: { gap: 24 },
  controls: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 16,
  },
  ctrlBtn: {
    width: 54,
    height: 54,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  ctrlBtnOn: { backgroundColor: colors.green },
  hint: {
    fontFamily: font.medium,
    fontSize: 12.5,
    color: "#BFE9CF",
    textAlign: "center",
  },
});
