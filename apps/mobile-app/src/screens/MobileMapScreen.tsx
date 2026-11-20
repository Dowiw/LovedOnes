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
    : [13.4448, 52.5069];

  return (
    <View style={styles.root}>
      <Map style={styles.map} mapStyle={mapStyle}>
        <Camera
          initialViewState={{
            center: centerCoord,
            zoom: 11,
          }}
        />
        {locations.map((loc) => (
          <Marker key={loc.userId} id={loc.userId} lngLat={[loc.longitude, loc.latitude]}>
            <View style={styles.marker}>
              <Text style={styles.markerLabel}>
                {loc.username}
                {loc.isFuzzed ? ' (~1km)' : ''}
              </Text>
              <View style={styles.markerHalo}>
                <View
                  style={[styles.markerDot, loc.isFuzzed ? styles.dotFuzzed : styles.dotExact]}
                />
              </View>
            </View>
          </Marker>
        ))}
      </Map>

      {/* Top Floating Search / Group Capsule & Filter Chips */}
      <View style={styles.topOverlay} pointerEvents="box-none">
        <View style={styles.topCapsule}>
          <View style={styles.topBrandDot} />
          <View style={styles.topTitleWrap}>
            <Text style={styles.topTitle} numberOfLines={1}>
              {activeGroup?.name ?? 'LovedOnes'}
            </Text>
            <Text style={styles.topSubtitle} numberOfLines={1}>
              {activeGroup ? `${activeGroup.myPrivacy} mode` : 'Live group map'}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.signOutPill}
            onPress={async () => {
              await stopBackgroundTracking().catch(() => {});
              await clearStoredConfig();
              onSignedOut();
            }}
          >
            <Text style={styles.signOutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipScroll}
        >
          {activeGroup &&
            (['EXACT', 'FUZZED', 'GHOST'] as PrivacyMode[]).map((mode) => {
              const selected = activeGroup.myPrivacy === mode;
              return (
                <TouchableOpacity
                  key={mode}
                  onPress={() => void handlePrivacyChange(mode)}
                  style={[styles.chipPill, selected && styles.chipPillActive]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextActive]}>
                    {mode}
                  </Text>
                </TouchableOpacity>
              );
            })}

          {permissionInfo && (
            <TouchableOpacity
              onPress={() => void handleRequestPermissions()}
              style={styles.chipPill}
            >
              <Text style={styles.chipPermText}>{permissionInfo.label}</Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        {statusBanner && (
          <View style={styles.statusToast}>
            <Text style={styles.statusToastText} numberOfLines={1}>
              {statusBanner}
            </Text>
          </View>
        )}
      </View>

      {/* Right-Side Floating Stacked Map Controls */}
      <View style={styles.rightStack}>
        <TouchableOpacity
          style={styles.stackBtn}
          onPress={() => void handleCacheOfflineMap()}
        >
          <Text style={styles.stackBtnText}>
            {localPmtilesUri ? 'Cached' : 'Cache'}
          </Text>
        </TouchableOpacity>
        <View style={styles.stackDivider} />
        <TouchableOpacity style={styles.stackBtn} onPress={() => void handleCheckOta()}>
          <Text style={styles.stackBtnText}>OTA</Text>
        </TouchableOpacity>
      </View>

      {/* Bottom Floating Mint CTA + White Rounded Sheet */}
      <View style={styles.bottomWrap} pointerEvents="box-none">
        <View style={styles.floatingCtaRow} pointerEvents="box-none">
          <TouchableOpacity
            style={styles.floatingCirclePill}
            onPress={() => void handlePingAndSync()}
          >
            <Text style={styles.floatingCircleText}>Sync ({queuedCount})</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.mintCta, tracking && styles.mintCtaTracking]}
            onPress={() => void handleToggleTracking()}
          >
            <View style={[styles.mintCtaDot, tracking && styles.mintCtaDotActive]} />
            <Text style={[styles.mintCtaText, tracking && styles.mintCtaTextActive]}>
              {tracking ? 'Live GPS On' : 'Start GPS'}
            </Text>
          </TouchableOpacity>

          <View style={styles.floatingSpacer} />
        </View>

        <View style={styles.bottomSheet}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetSummary}>
            {locations.length} {locations.length === 1 ? 'member' : 'members'} visible
          </Text>

          {locations.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.memberStrip}
            >
              {locations.map((loc) => (
                <View key={loc.userId} style={styles.memberChip}>
                  <View
                    style={[
                      styles.memberChipDot,
                      loc.isFuzzed ? styles.dotFuzzed : styles.dotExact,
                    ]}
                  />
                  <Text style={styles.memberChipText}>
                    {loc.username}
                    {loc.isFuzzed ? ' ~1km' : ''}
                  </Text>
                </View>
              ))}
            </ScrollView>
          )}

          <View style={styles.tabBar}>
            <TouchableOpacity style={[styles.tabItem, styles.tabItemActive]}>
              <Text style={[styles.tabLabel, styles.tabLabelActive]}>Map</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.tabItem}
              onPress={() => void handlePingAndSync()}
            >
              <Text style={styles.tabLabel}>Sync ({queuedCount})</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.tabItem} onPress={() => setChatOpen(true)}>
              <Text style={styles.tabLabel}>Chat ({messages.length})</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Minimalist White Chat Sheet Modal */}
      <Modal visible={chatOpen} animationType="slide" onRequestClose={() => setChatOpen(false)}>
        <View style={styles.modalWrap}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitle}>{activeGroup?.name ?? 'Group'} Chat</Text>
              <Text style={styles.modalSubtitle}>{messages.length} messages</Text>
            </View>
            <TouchableOpacity style={styles.closePill} onPress={() => setChatOpen(false)}>
              <Text style={styles.closeText}>Done</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.chatList} contentContainerStyle={styles.chatListContent}>
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
              placeholder="Write a message..."
              placeholderTextColor="#94a3b8"
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
  root: { flex: 1, backgroundColor: '#cfe3ee' },
  map: { flex: 1 },
  marker: { alignItems: 'center' },
  markerLabel: {
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    color: '#18181b',
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
  },
  markerHalo: {
    width: 24,
    height: 24,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0f172a',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  markerDot: { width: 12, height: 12, borderRadius: 999 },
  dotExact: { backgroundColor: '#16a34a' },
  dotFuzzed: { backgroundColor: '#d97706' },
  topOverlay: {
    position: 'absolute',
    top: 48,
    left: 14,
    right: 14,
    gap: 10,
  },
  topCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: 999,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 10,
    borderWidth: 1,
    borderColor: 'rgba(226, 232, 240, 0.9)',
    shadowColor: '#0f172a',
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  topBrandDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: '#80f15a',
  },
  topTitleWrap: {
    flex: 1,
  },
  topTitle: {
    color: '#18181b',
    fontWeight: '700',
    fontSize: 15,
  },
  topSubtitle: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '500',
  },
  signOutPill: {
    backgroundColor: '#f1f5f9',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  signOutText: {
    color: '#18181b',
    fontSize: 11,
    fontWeight: '700',
  },
  chipScroll: {
    gap: 8,
    paddingRight: 12,
  },
  chipPill: {
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(226, 232, 240, 0.95)',
    shadowColor: '#0f172a',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  chipPillActive: {
    borderColor: '#18181b',
    backgroundColor: '#ffffff',
  },
  chipText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '600',
  },
  chipTextActive: {
    color: '#18181b',
    fontWeight: '700',
  },
  chipPermText: {
    color: '#18181b',
    fontSize: 12,
    fontWeight: '600',
  },
  statusToast: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(24, 24, 27, 0.88)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  statusToastText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
  rightStack: {
    position: 'absolute',
    right: 14,
    top: 168,
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#0f172a',
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
    overflow: 'hidden',
  },
  stackBtn: {
    paddingHorizontal: 12,
    paddingVertical: 11,
    alignItems: 'center',
  },
  stackBtnText: {
    color: '#18181b',
    fontSize: 11,
    fontWeight: '700',
  },
  stackDivider: {
    height: 1,
    backgroundColor: '#e2e8f0',
  },
  bottomWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: 12,
  },
  floatingCtaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
  },
  floatingCirclePill: {
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#0f172a',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  floatingCircleText: {
    color: '#18181b',
    fontSize: 11,
    fontWeight: '700',
  },
  floatingSpacer: {
    width: 72,
  },
  mintCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#80f15a',
    borderRadius: 999,
    paddingHorizontal: 22,
    paddingVertical: 12,
    shadowColor: '#0f172a',
    shadowOpacity: 0.16,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6,
  },
  mintCtaTracking: {
    backgroundColor: '#18181b',
  },
  mintCtaDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#09090b',
  },
  mintCtaDotActive: {
    backgroundColor: '#80f15a',
  },
  mintCtaText: {
    color: '#09090b',
    fontWeight: '700',
    fontSize: 14,
  },
  mintCtaTextActive: {
    color: '#ffffff',
  },
  bottomSheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingTop: 10,
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 10,
    shadowColor: '#0f172a',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -4 },
    elevation: 10,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 999,
    backgroundColor: '#e2e8f0',
  },
  sheetSummary: {
    textAlign: 'center',
    color: '#18181b',
    fontSize: 15,
    fontWeight: '700',
  },
  memberStrip: {
    gap: 8,
    paddingVertical: 2,
  },
  memberChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#f8fafc',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  memberChipDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  memberChipText: {
    color: '#18181b',
    fontSize: 12,
    fontWeight: '600',
  },
  tabBar: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 4,
  },
  tabItem: {
    flex: 1,
    borderRadius: 999,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tabItemActive: {
    backgroundColor: '#f1f5f9',
  },
  tabLabel: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: '#18181b',
    fontWeight: '700',
  },
  modalWrap: { flex: 1, backgroundColor: '#eef3f6', paddingTop: 52 },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { color: '#18181b', fontSize: 18, fontWeight: '700' },
  modalSubtitle: { color: '#64748b', fontSize: 12 },
  closePill: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  closeText: { color: '#18181b', fontSize: 13, fontWeight: '700' },
  chatList: { flex: 1 },
  chatListContent: { padding: 16, gap: 10 },
  chatBubble: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chatSender: { color: '#16a34a', fontSize: 11, fontWeight: '700', marginBottom: 3 },
  chatBody: { color: '#18181b', fontSize: 14 },
  chatComposer: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 28,
    gap: 8,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  chatInput: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#18181b',
    fontSize: 14,
  },
  sendBtn: {
    backgroundColor: '#18181b',
    borderRadius: 999,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  sendBtnText: { color: '#ffffff', fontWeight: '700', fontSize: 13 },
});
