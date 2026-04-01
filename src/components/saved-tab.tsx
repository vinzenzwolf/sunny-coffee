import React from 'react';
import {
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useCafeData } from '../context/cafe-data-context';
import { useSavedCafes } from '../context/saved-cafes-context';
import { useAuth } from '../context/auth-context';
import { getOpenUntilToday } from '../utils/opening-hours';
import type { Cafe } from '../types';

const CHART_START = 6 * 60;
const CHART_END = 22 * 60;
const CHART_RANGE = CHART_END - CHART_START;

type SunInterval = { start: string; end: string };

function parseHHmm(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
  return Math.min(24 * 60, hour * 60 + minute);
}

function nowMinutesInCopenhagen(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

function sunSummary(intervals: SunInterval[]): string {
  if (!intervals.length) return 'No direct sun windows available today';
  const top = intervals.slice(0, 3).map((it) => `${it.start}-${it.end}`).join('  ·  ');
  return `Sun today: ${top}`;
}

function todayOpenLabel(cafe: Cafe): string {
  const open = getOpenUntilToday(cafe.metadata?.openingHours);
  if (open.isOpen && open.closesAt) return `Open until ${open.closesAt}`;
  if (open.isOpen) return 'Open now';
  return 'Closed now';
}

function chartSegments(intervals: SunInterval[]): { left: `${number}%`; width: `${number}%` }[] {
  return intervals
    .map((it) => {
      const start = parseHHmm(it.start);
      const end = parseHHmm(it.end);
      if (start === null || end === null || end <= start) return null;
      const clippedStart = Math.max(CHART_START, Math.min(CHART_END, start));
      const clippedEnd = Math.max(CHART_START, Math.min(CHART_END, end));
      if (clippedEnd <= clippedStart) return null;
      const leftPct = ((clippedStart - CHART_START) / CHART_RANGE) * 100;
      const widthPct = ((clippedEnd - clippedStart) / CHART_RANGE) * 100;
      return { left: `${leftPct}%`, width: `${widthPct}%` };
    })
    .filter((seg): seg is { left: `${number}%`; width: `${number}%` } => seg !== null);
}

async function openCafeInGoogleMaps(cafe: Cafe): Promise<void> {
  const apiKey = process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY;
  if (apiKey && cafe.id) {
    try {
      const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(cafe.id)}`, {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'googleMapsUri',
        },
      });
      if (res.ok) {
        const data = (await res.json()) as { googleMapsUri?: string };
        if (data.googleMapsUri) {
          await Linking.openURL(data.googleMapsUri);
          return;
        }
      }
    } catch {
      // Fallback below.
    }
  }

  if (cafe.id) {
    await Linking.openURL(`https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(cafe.id)}`);
    return;
  }
  await Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${cafe.lat},${cafe.lng}`);
}

type Props = {
  topInset: number;
  bottomInset: number;
  onBrowse: () => void;
};

export default function SavedTab({ topInset, bottomInset, onBrowse }: Props) {
  const { user } = useAuth();
  const { cafes } = useCafeData();
  const { savedIds, toggle } = useSavedCafes();

  const savedCafes = cafes.filter((c) => savedIds.has(c.id));
  const sunCount = savedCafes.filter((c) => c.metadata?.inSunNow).length;
  const nowMarkerPct: `${number}%` = (() => {
    const now = nowMinutesInCopenhagen();
    const clamped = Math.max(CHART_START, Math.min(CHART_END, now));
    return `${((clamped - CHART_START) / CHART_RANGE) * 100}%`;
  })();

  if (!user) {
    return (
      <View style={[styles.container, { paddingTop: topInset }]}> 
        <ScrollView contentContainerStyle={[styles.emptyContent, { paddingBottom: bottomInset + 24 }]}> 
          <View style={styles.header}> 
            <Text style={styles.title}>Your <Text style={styles.titleItalic}>favorites</Text></Text>
            <Text style={styles.subtitle}>Sign in to save cafes</Text>
          </View>
          <View style={styles.empty}> 
            <View style={styles.emptyIcon}> 
              <Ionicons name="bookmark-outline" size={28} color="#C8C4BF" />
            </View>
            <Text style={styles.emptyTitle}>Save your <Text style={styles.emptyTitleItalic}>sunny spots</Text></Text>
            <Text style={styles.emptyBody}>Sign in to save cafes and see when they are in the sun.</Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (savedCafes.length === 0) {
    return (
      <View style={[styles.container, { paddingTop: topInset }]}> 
        <ScrollView contentContainerStyle={[styles.emptyContent, { paddingBottom: bottomInset + 24 }]}> 
          <View style={styles.header}> 
            <Text style={styles.title}>Your <Text style={styles.titleItalic}>favorites</Text></Text>
            <Text style={[styles.subtitle, { color: '#D8D4CF' }]}>No cafes saved yet</Text>
          </View>
          <View style={styles.empty}> 
            <View style={styles.emptyIcon}> 
              <Ionicons name="heart-outline" size={28} color="#C8C4BF" />
            </View>
            <Text style={styles.emptyTitle}>Save your <Text style={styles.emptyTitleItalic}>sunny spots</Text></Text>
            <Text style={styles.emptyBody}>Tap the heart on any cafe to save it here.</Text>
            <TouchableOpacity style={styles.browseBtn} onPress={onBrowse} activeOpacity={0.85}>
              <Text style={styles.browseBtnText}>Browse cafes</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: topInset }]}> 
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bottomInset + 24 }}
      >
        <View style={styles.header}> 
          <Text style={styles.title}>Your <Text style={styles.titleItalic}>favorites</Text></Text>
          <Text style={styles.subtitle}> 
            {sunCount > 0
              ? <><Text style={styles.subtitleBold}>{sunCount} in the sun</Text> right now</>
              : `${savedCafes.length} saved`}
          </Text>
        </View>

        <View style={styles.list}> 
          {savedCafes.map((cafe) => {
            const intervals = cafe.metadata?.sunWindows ?? [];
            const segments = chartSegments(intervals);
            return (
              <View key={cafe.id} style={styles.card}> 
                <View style={styles.cardHeader}> 
                  <View style={styles.cardTitleWrap}> 
                    <Text style={styles.cardName} numberOfLines={1}>{cafe.name}</Text>
                    <Text style={styles.cardOpen}>{todayOpenLabel(cafe)}</Text>
                  </View>
                  <View style={styles.cardActions}>
                    <TouchableOpacity
                      style={styles.navBtn}
                      onPress={() => {
                        void openCafeInGoogleMaps(cafe);
                      }}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="navigate-outline" size={14} color="#fff" />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.heartBtn}
                      onPress={() => toggle(cafe.id)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="heart" size={14} color="#fff" />
                    </TouchableOpacity>
                  </View>
                </View>

                <Text style={styles.sunSummary}>{sunSummary(intervals)}</Text>

                <View style={styles.chartWrap}> 
                  <View style={styles.chartTrack}>
                    {segments.map((seg, idx) => (
                      <View
                        key={`${cafe.id}-seg-${idx}`}
                        style={[styles.chartSunSegment, { left: seg.left, width: seg.width }]}
                      />
                    ))}
                    <View style={[styles.chartNowMarker, { left: nowMarkerPct }]} />
                  </View>

                  <View style={styles.chartLabels}> 
                    <Text style={styles.chartLabel}>06:00</Text>
                    <Text style={styles.chartLabel}>14:00</Text>
                    <Text style={styles.chartLabel}>22:00</Text>
                  </View>
                </View>

                <Text numberOfLines={1} style={styles.addressLine}>
                  {cafe.googleFormattedAddress || 'Copenhagen'}
                </Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#F5F3F0',
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: '300',
    color: '#1C1B19',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    letterSpacing: -0.3,
    marginBottom: 4,
  },
  titleItalic: {
    fontStyle: 'italic',
    color: '#F5A623',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  subtitle: {
    fontSize: 12,
    color: '#B8B4AF',
  },
  subtitleBold: {
    fontWeight: '600',
    color: '#1C1B19',
  },

  list: {
    paddingHorizontal: 16,
    gap: 12,
  },
  card: {
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#ECE8E2',
    padding: 14,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 9 },
      android: { elevation: 2 },
    }),
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    gap: 10,
  },
  cardTitleWrap: {
    flex: 1,
  },
  cardName: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '600',
    color: '#1D1B18',
  },
  cardOpen: {
    marginTop: 2,
    fontSize: 12,
    color: '#7B766E',
    fontWeight: '500',
  },
  heartBtn: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: '#E39A44',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  navBtn: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: '#3C3834',
    alignItems: 'center',
    justifyContent: 'center',
  },

  sunSummary: {
    fontSize: 12,
    color: '#5F5A54',
    marginBottom: 10,
  },

  chartWrap: {
    marginBottom: 10,
  },
  chartTrack: {
    position: 'relative',
    height: 18,
    borderRadius: 9,
    backgroundColor: '#ECE8E2',
    overflow: 'hidden',
  },
  chartSunSegment: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRadius: 9,
    backgroundColor: '#F2B24D',
  },
  chartNowMarker: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    width: 2,
    marginLeft: -1,
    backgroundColor: '#2B2723',
    opacity: 0.85,
  },
  chartLabels: {
    marginTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  chartLabel: {
    fontSize: 10,
    color: '#9A948D',
  },

  addressLine: {
    fontSize: 11,
    color: '#A39D95',
  },

  emptyContent: {
    flexGrow: 1,
  },
  empty: {
    alignItems: 'center',
    paddingHorizontal: 40,
    paddingTop: 40,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    backgroundColor: '#EDEAE6',
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  emptyTitle: {
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    fontSize: 26,
    fontWeight: '300',
    color: '#1C1B19',
    marginBottom: 8,
    lineHeight: 30,
    textAlign: 'center',
  },
  emptyTitleItalic: {
    fontStyle: 'italic',
    color: '#F5A623',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  emptyBody: {
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 20,
    color: '#A8A49E',
    marginBottom: 18,
  },
  browseBtn: {
    marginTop: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#DFDAD2',
    backgroundColor: '#F6F3EF',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  browseBtnText: {
    color: '#6E6A64',
    fontSize: 13,
    fontWeight: '600',
  },
});
