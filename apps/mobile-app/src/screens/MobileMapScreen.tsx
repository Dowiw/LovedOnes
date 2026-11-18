import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Camera, Map, Marker } from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import { io, Socket } from 'socket.io-client';
import type { ChatMessage, LocationBroadcast, PrivacyMode } from '@loved-ones/shared';
import {
  isBackgroundTrackingActive,
  startBackgroundTracking,
  stopBackgroundTracking,
} from '../services/backgroundLocation';
import {
  LocationPermissionResult,
  requestLocationPermissionsOnLaunch,
} from '../services/locationPermissions';
import {
  enqueueLocationPoints,
  flushOfflineLocations,
  getPendingLocationCount,
} from '../services/offlineQueue';
import {
  buildMobileMapStyle,
  checkForOtaUpdate,
  downloadOfflineRegionPmtiles,
  getCachedRegionPmtilesUri,
} from '../services/pmtilesStyle';
import { clearStoredConfig, MobileStoredConfig, saveStoredConfig } from '../services/secureConfig';

interface GroupSummary {
  id: string;
  name: string;
  myPrivacy: PrivacyMode;
}

interface MobileMapScreenProps {
  config: MobileStoredConfig;
  onSignedOut: () => void;
}

export function MobileMapScreen({ config, onSignedOut }: MobileMapScreenProps) {
  const serverUrl = (config.serverUrl ?? '').replace(/\/$/, '');
  const accessToken = config.accessToken ?? '';

  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string>(config.activeGroupId ?? '');
  const [locations, setLocations] = useState<LocationBroadcast[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState('');
  const [chatOpen, setChatOpen] = useState(false);

  const [tracking, setTracking] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [localPmtilesUri, setLocalPmtilesUri] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [permissionInfo, setPermissionInfo] = useState<LocationPermissionResult | null>(null);

  const socketRef = useRef<Socket | null>(null);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? groups[0] ?? null,
    [groups, activeGroupId],
  );

  const mapStyle = useMemo(
    () => buildMobileMapStyle(serverUrl, localPmtilesUri),
    [serverUrl, localPmtilesUri],
  );

  const refreshQueueCount = useCallback(async () => {
    const cnt = await getPendingLocationCount();
    setQueuedCount(cnt);
  }, []);

  useEffect(() => {
    void requestLocationPermissionsOnLaunch()
      .then((perm) => {
        setPermissionInfo(perm);
      })
      .catch(() => {});
    void isBackgroundTrackingActive().then(setTracking).catch(() => {});
    void getCachedRegionPmtilesUri().then(setLocalPmtilesUri).catch(() => {});
    void refreshQueueCount().catch(() => {});
  }, [refreshQueueCount]);

  async function handleRequestPermissions() {
    try {
      const perm = await requestLocationPermissionsOnLaunch();
      setPermissionInfo(perm);
      setStatusBanner(perm.label);
    } catch (err) {
      setStatusBanner(err instanceof Error ? err.message : 'Unable to request location permission');
    }
  }

  useEffect(() => {
    if (!serverUrl || !accessToken) return;
    void fetch(`${serverUrl}/api/auth/groups`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => r.json())
      .then((data: { groups?: GroupSummary[] }) => {
        const list = data.groups ?? [];
        setGroups(list);
        if (list.length > 0 && !activeGroupId) {
          setActiveGroupId(list[0].id);
          void saveStoredConfig({ activeGroupId: list[0].id });
        }
      })
      .catch(() => {});
  }, [serverUrl, accessToken, activeGroupId]);

  useEffect(() => {
    if (!serverUrl || !accessToken) return;
    const socket = io(serverUrl, {
      auth: { token: accessToken },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('location:update', (update: LocationBroadcast) => {
      setLocations((prev) => {
        if (activeGroup && update.groupId !== activeGroup.id) return prev;
        const idx = prev.findIndex((p) => p.userId === update.userId);
        if (idx === -1) return [...prev, update];
        const next = [...prev];
        next[idx] = update;
        return next;
      });
    });

    socket.on('chat:message', (msg: ChatMessage) => {
      setMessages((prev) => {
        if (activeGroup && msg.groupId !== activeGroup.id) return prev;
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [serverUrl, accessToken, activeGroup]);

  useEffect(() => {
    if (!serverUrl || !accessToken || !activeGroup) return;
    socketRef.current?.emit('group:join', activeGroup.id);

    void fetch(`${serverUrl}/api/realtime/groups/${activeGroup.id}/locations`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => r.json())
      .then((d: { locations?: LocationBroadcast[] }) => setLocations(d.locations ?? []))
      .catch(() => {});

    void fetch(`${serverUrl}/api/realtime/groups/${activeGroup.id}/messages`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => r.json())
      .then((d: { messages?: ChatMessage[] }) => setMessages(d.messages ?? []))
      .catch(() => {});
  }, [serverUrl, accessToken, activeGroup]);

  async function handleToggleTracking() {
    try {
      if (tracking) {
        await stopBackgroundTracking();
        setTracking(false);
        setStatusBanner('Location tracking paused');
      } else {
        const started = await startBackgroundTracking();
        setPermissionInfo(started.permission);
        setTracking(true);
        setStatusBanner(
          started.mode === 'background'
            ? 'Background GPS beacon active (Always Allow)'
            : 'Foreground GPS beacon active (While Using App fallback)',
        );
      }
    } catch (err) {
      setStatusBanner(err instanceof Error ? err.message : 'Unable to toggle location tracking');
    }
  }

  async function handlePingAndSync() {
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== 'granted') {
        setStatusBanner('Location permission required');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await enqueueLocationPoints([
        {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          altitude: pos.coords.altitude ?? null,
          accuracy:
            typeof pos.coords.accuracy === 'number' && pos.coords.accuracy >= 0
              ? pos.coords.accuracy
              : null,
          speed: pos.coords.speed && pos.coords.speed >= 0 ? pos.coords.speed : null,
          batteryLevel: null,
          recordedAt: new Date(pos.timestamp || Date.now()).toISOString(),
        },
      ]);
      const result = await flushOfflineLocations(serverUrl, accessToken);
      await refreshQueueCount();
      setStatusBanner(`Synced ${result.flushed} points (${result.remaining} queued)`);
    } catch (err) {
      await refreshQueueCount();
      setStatusBanner(err instanceof Error ? err.message : 'Saved offline in SQLite queue');
    }
  }

  async function handlePrivacyChange(mode: PrivacyMode) {
    if (!activeGroup) return;
    await fetch(`${serverUrl}/api/auth/groups/${activeGroup.id}/privacy`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ privacy: mode }),
    });
    setGroups((prev) => prev.map((g) => (g.id === activeGroup.id ? { ...g, myPrivacy: mode } : g)));
  }

  async function handleCacheOfflineMap() {
    try {
      const uri = await downloadOfflineRegionPmtiles(serverUrl);
      setLocalPmtilesUri(uri);
      setStatusBanner('Cached regional PMTiles for offline rendering');
    } catch (err) {
      setStatusBanner(err instanceof Error ? err.message : 'Tile cache failed');
    }
  }

  async function handleCheckOta() {
    try {
      const res = await checkForOtaUpdate();
      setStatusBanner(res.message);
    } catch (err) {
      setStatusBanner(err instanceof Error ? err.message : 'OTA check failed');
    }
  }

  function handleSendChat() {
    if (!activeGroup || !chatText.trim() || !socketRef.current) return;
    socketRef.current.emit('chat:send', {
      groupId: activeGroup.id,
      content: chatText.trim(),
    });
    setChatText('');
  }

  const centerCoord: [number, number] = locations[0]
    ? [locations[0].longitude, locations[0].latitude]
    : [2.3522, 48.8566];

  return (
    <View style={styles.root}>
      <Map style={styles.map} mapStyle={mapStyle}>
        <Camera
          initialViewState={{
            center: centerCoord,
            zoom: locations.length > 0 ? 11 : 3,
          }}
        />
        {locations.map((loc) => (
          <Marker key={loc.userId} id={loc.userId} lngLat={[loc.longitude, loc.latitude]}>
            <View style={styles.marker}>
              <Text style={styles.markerLabel}>
                {loc.username} {loc.isFuzzed ? '(~1km)' : ''}
              </Text>
              <View
                style={[styles.markerDot, loc.isFuzzed ? styles.dotFuzzed : styles.dotExact]}
              />
            </View>
          </Marker>
        ))}
      </Map>

      {/* Top HUD */}
      <View style={styles.topHud}>
        <View style={styles.hudRow}>
          <Text style={styles.hudTitle}>{activeGroup?.name ?? 'LovedOnes'}</Text>
          <TouchableOpacity
            style={styles.smallBtn}
            onPress={async () => {
              await stopBackgroundTracking().catch(() => {});
              await clearStoredConfig();
              onSignedOut();
            }}
          >
            <Text style={styles.smallBtnText}>Sign Out</Text>
          </TouchableOpacity>
        </View>
        {permissionInfo && (
          <TouchableOpacity
            onPress={() => void handleRequestPermissions()}
            style={styles.permBannerBtn}
          >
            <Text style={styles.permBannerText}>{permissionInfo.label}</Text>
          </TouchableOpacity>
        )}
        {statusBanner && <Text style={styles.statusText}>{statusBanner}</Text>}
      </View>

      {/* Bottom Controls */}
      <View style={styles.bottomHud}>
        {activeGroup && (
          <View style={styles.privacyRow}>
            {(['EXACT', 'FUZZED', 'GHOST'] as PrivacyMode[]).map((mode) => (
              <TouchableOpacity
                key={mode}
                onPress={() => void handlePrivacyChange(mode)}
                style={[
                  styles.pillBtn,
                  activeGroup.myPrivacy === mode && styles.pillBtnActive,
                ]}
              >
                <Text style={styles.pillText}>{mode}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.actionBtn, tracking ? styles.stopBtn : styles.startBtn]}
            onPress={() => void handleToggleTracking()}
          >
            <Text style={styles.actionBtnText}>
              {tracking ? 'Stop Background GPS' : 'Start Background GPS'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryBtn} onPress={() => void handlePingAndSync()}>
            <Text style={styles.secondaryText}>Sync Queue ({queuedCount})</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setChatOpen(true)}>
            <Text style={styles.secondaryText}>Group Chat ({messages.length})</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => void handleCacheOfflineMap()}>
            <Text style={styles.secondaryText}>
              {localPmtilesUri ? 'PMTiles Cached' : 'Cache PMTiles'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => void handleCheckOta()}>
            <Text style={styles.secondaryText}>OTA Check</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Modal visible={chatOpen} animationType="slide" onRequestClose={() => setChatOpen(false)}>
        <View style={styles.modalWrap}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{activeGroup?.name ?? 'Group'} Chat</Text>
            <TouchableOpacity onPress={() => setChatOpen(false)}>
              <Text style={styles.closeText}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.chatList}>
            {messages.map((m) => (
              <View key={m.id} style={styles.chatBubble}>
                <Text style={styles.chatSender}>{m.senderUsername}</Text>
                <Text style={styles.chatBody}>{m.content}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.chatComposer}>
            <TextInput
              style={styles.chatInput}
              value={chatText}
              onChangeText={setChatText}
              placeholder="Send message..."
              placeholderTextColor="#64748b"
            />
            <TouchableOpacity style={styles.sendBtn} onPress={handleSendChat}>
              <Text style={styles.sendBtnText}>Send</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#020617' },
  map: { flex: 1 },
  marker: { alignItems: 'center' },
  markerLabel: {
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
    color: '#f8fafc',
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginBottom: 2,
  },
  markerDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: '#fff' },
  dotExact: { backgroundColor: '#10b981' },
  dotFuzzed: { backgroundColor: '#f59e0b' },
  topHud: {
    position: 'absolute',
    top: 46,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  hudRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hudTitle: { color: '#f8fafc', fontWeight: '700', fontSize: 15 },
  permBannerBtn: {
    marginTop: 6,
    backgroundColor: '#1e293b',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  permBannerText: { color: '#38bdf8', fontSize: 11, fontWeight: '600' },
  statusText: { color: '#94a3b8', fontSize: 11, marginTop: 4 },
  smallBtn: { backgroundColor: '#1e293b', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  smallBtnText: { color: '#cbd5e1', fontSize: 11, fontWeight: '600' },
  bottomHud: {
    position: 'absolute',
    bottom: 24,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.94)',
    borderRadius: 14,
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  privacyRow: { flexDirection: 'row', gap: 6 },
  pillBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 7,
    alignItems: 'center',
    backgroundColor: '#020617',
    borderWidth: 1,
    borderColor: '#334155',
  },
  pillBtnActive: { backgroundColor: '#0284c7', borderColor: '#38bdf8' },
  pillText: { color: '#f8fafc', fontSize: 11, fontWeight: '700' },
  actionRow: { flexDirection: 'row', gap: 6 },
  actionBtn: { flex: 1, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  startBtn: { backgroundColor: '#10b981' },
  stopBtn: { backgroundColor: '#f43f5e' },
  actionBtnText: { color: '#020617', fontWeight: '700', fontSize: 12 },
  secondaryBtn: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryText: { color: '#e2e8f0', fontSize: 11, fontWeight: '600' },
  modalWrap: { flex: 1, backgroundColor: '#020617', paddingTop: 48 },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  modalTitle: { color: '#f8fafc', fontSize: 16, fontWeight: '700' },
  closeText: { color: '#38bdf8', fontSize: 14, fontWeight: '600' },
  chatList: { flex: 1, padding: 14 },
  chatBubble: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  chatSender: { color: '#38bdf8', fontSize: 11, fontWeight: '700', marginBottom: 2 },
  chatBody: { color: '#f8fafc', fontSize: 13 },
  chatComposer: {
    flexDirection: 'row',
    padding: 12,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  chatInput: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f8fafc',
  },
  sendBtn: {
    backgroundColor: '#38bdf8',
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  sendBtnText: { color: '#020617', fontWeight: '700' },
});
