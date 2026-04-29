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

function todayOpenStatus(cafe: Cafe): { label: string; color: string } {
  const result = getOpenUntilToday(cafe.metadata?.openingHours);
  if (result.isOpen) {
    return {
      label: result.closesAt ? `Open until ${result.closesAt}` : 'Open now',
      color: '#4A9B6F',
    };
  }
  if (result.reason === 'closed_today') return { label: 'Closed today', color: '#A39D95' };
  if (result.reason === 'no_data') return { label: 'No opening hours', color: '#C8C4BF' };
  return { label: 'Closed now', color: '#A39D95' };
}

// Estimated width of a "HH:MM–HH:MM" label as % of chart width.
// Card inner width ≈ 330px; "10:30–13:00" (11 chars × ~5.5px) ≈ 60px → ~18%.
const LABEL_WIDTH_PCT = 19;

type ChartData = {
  segments: { left: `${number}%`; width: `${number}%` }[];
  labels: { text: string; left: `${number}%` }[];
};

function chartData(intervals: SunInterval[]): ChartData {
  const segments: ChartData['segments'] = [];
  const candidates: { centerPct: number; text: string }[] = [];

  for (const it of intervals) {
    const start = parseHHmm(it.start);
    const end = parseHHmm(it.end);
    if (start === null || end === null || end <= start) continue;
    const clippedStart = Math.max(CHART_START, Math.min(CHART_END, start));
    const clippedEnd = Math.max(CHART_START, Math.min(CHART_END, end));
    if (clippedEnd <= clippedStart) continue;
    const leftPct = ((clippedStart - CHART_START) / CHART_RANGE) * 100;
    const widthPct = ((clippedEnd - clippedStart) / CHART_RANGE) * 100;
    segments.push({ left: `${leftPct}%`, width: `${widthPct}%` });
    candidates.push({ centerPct: leftPct + widthPct / 2, text: `${it.start}–${it.end}` });
  }

  // Greedy non-overlapping label selection: skip a label if it would
  // overlap the previous one (after clamping to chart bounds).
  const labels: ChartData['labels'] = [];
  let lastRightEdge = -Infinity;
  for (const c of candidates) {
    const rawLeft = c.centerPct - LABEL_WIDTH_PCT / 2;
    const left = Math.max(0, Math.min(100 - LABEL_WIDTH_PCT, rawLeft));
    if (left >= lastRightEdge - 1) {
      labels.push({ text: c.text, left: `${left}%` });
      lastRightEdge = left + LABEL_WIDTH_PCT;
    }
  }

  return { segments, labels };
}

function openCafeInGoogleMaps(cafe: Cafe): Promise<void> {
  return Linking.openURL(
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cafe.name)}&query_place_id=${encodeURIComponent(cafe.id)}`,
  );
}

type Props = {
  topInset: number;
  bottomInset: number;
  onBrowse: () => void;
  onSelectCafe?: (cafe: Cafe) => void;
};

export default function SavedTab({ topInset, bottomInset, onBrowse, onSelectCafe }: Props) {
  const { user } = useAuth();
  const { cafes } = useCafeData();
  const { savedIds, toggle } = useSavedCafes();

  const savedCafes = cafes.filter((c) => savedIds.has(c.id));
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
          <Text style={styles.subtitle}>{savedCafes.length} saved</Text>
        </View>

        <View style={styles.list}> 
          {savedCafes.map((cafe) => {
            const intervals = cafe.metadata?.sunWindows ?? [];
            const { segments, labels } = chartData(intervals);
            const openStatus = todayOpenStatus(cafe);
            return (
              <View key={cafe.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={styles.cardTitleWrap}>
                    <TouchableOpacity
                      onPress={() => onSelectCafe?.(cafe)}
                      activeOpacity={onSelectCafe ? 0.6 : 1}
                      disabled={!onSelectCafe}
                    >
                      <Text style={styles.cardName} numberOfLines={1}>{cafe.name}</Text>
                    </TouchableOpacity>
                    <Text style={[styles.cardOpen, { color: openStatus.color }]}>{openStatus.label}</Text>
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

                  {labels.length > 0 && (
                    <View style={styles.chartLabelRow}>
                      {labels.map((lbl, idx) => (
                        <Text
                          key={`${cafe.id}-lbl-${idx}`}
                          style={[styles.chartWindowLabel, { left: lbl.left, width: `${LABEL_WIDTH_PCT}%` }]}
                          numberOfLines={1}
                        >
                          {lbl.text}
                        </Text>
                      ))}
                    </View>
                  )}
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
  chartLabelRow: {
    position: 'relative',
    height: 16,
    marginTop: 4,
  },
  chartWindowLabel: {
    position: 'absolute',
    textAlign: 'center',
    fontSize: 9,
    color: '#C48A2E',
    fontWeight: '500',
    letterSpacing: 0.1,
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
