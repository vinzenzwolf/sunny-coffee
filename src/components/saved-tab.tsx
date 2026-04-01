import React from 'react';
import {
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

const GRADIENTS_SUN = [
  ['#F0C87A', '#D4944A', '#B06828'],
  ['#E8D4A0', '#C4A060', '#9A7038'],
  ['#F4D890', '#D8A848', '#AA7C28'],
  ['#DCC890', '#B89450', '#8C6A28'],
];
const GRADIENT_SHADE = ['#C8C4BC', '#A8A49C', '#888480'];
const GRADIENT_CLOSED = ['#C0BCB4', '#A09C94', '#807C74'];

function cafeGradient(cafe: Cafe, idx: number): string[] {
  const open = getOpenUntilToday(cafe.metadata?.openingHours);
  if (!open.isOpen) return GRADIENT_CLOSED;
  if (cafe.metadata?.inSunNow) return GRADIENTS_SUN[idx % GRADIENTS_SUN.length];
  return GRADIENT_SHADE;
}

function cafeTag(cafe: Cafe): { label: string; style: 'sun' | 'later' | 'closed' } {
  const open = getOpenUntilToday(cafe.metadata?.openingHours);
  if (!open.isOpen) return { label: 'Closed', style: 'closed' };
  if (cafe.metadata?.inSunNow) return { label: `☀ Until ${open.closesAt ?? '–'}`, style: 'sun' };
  return { label: '🌤 Sun later', style: 'later' };
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

  const savedCafes = cafes.filter(c => savedIds.has(c.id));
  const sunCount = savedCafes.filter(c => c.metadata?.inSunNow).length;

  if (!user) {
    return (
      <View style={[styles.container, { paddingTop: topInset }]}>
        <ScrollView contentContainerStyle={[styles.emptyContent, { paddingBottom: bottomInset + 24 }]}>
          <View style={styles.header}>
            <Text style={styles.title}>Your <Text style={styles.titleItalic}>favourites</Text></Text>
            <Text style={styles.subtitle}>Sign in to save cafés</Text>
          </View>
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="bookmark-outline" size={28} color="#C8C4BF" />
            </View>
            <Text style={styles.emptyTitle}>Save your <Text style={styles.emptyTitleItalic}>sunny spots</Text></Text>
            <Text style={styles.emptyBody}>Sign in to save cafés and see when they're in the sun.</Text>
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
            <Text style={styles.title}>Your <Text style={styles.titleItalic}>favourites</Text></Text>
            <Text style={[styles.subtitle, { color: '#D8D4CF' }]}>No cafés saved yet</Text>
          </View>
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="heart-outline" size={28} color="#C8C4BF" />
            </View>
            <Text style={styles.emptyTitle}>Save your <Text style={styles.emptyTitleItalic}>sunny spots</Text></Text>
            <Text style={styles.emptyBody}>Tap the heart on any café to save it here. We'll show you when they're in the sun.</Text>
            <TouchableOpacity style={styles.browseBtn} onPress={onBrowse} activeOpacity={0.85}>
              <Text style={styles.browseBtnText}>Browse cafés →</Text>
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
          <Text style={styles.title}>Your <Text style={styles.titleItalic}>favourites</Text></Text>
          <Text style={styles.subtitle}>
            {sunCount > 0
              ? <><Text style={styles.subtitleBold}>{sunCount} in the sun</Text> right now</>
              : `${savedCafes.length} saved`}
          </Text>
        </View>

        <View style={styles.grid}>
          {savedCafes.map((cafe, idx) => {
            const gradient = cafeGradient(cafe, idx);
            const tag = cafeTag(cafe);
            const open = getOpenUntilToday(cafe.metadata?.openingHours);
            const dim = !cafe.metadata?.inSunNow;

            return (
              <View key={cafe.id} style={[styles.card, dim && styles.cardDim]}>
                {/* Photo area with gradient */}
                <View style={[styles.photo, { backgroundColor: gradient[1] }]}>
                  <View style={[StyleSheet.absoluteFill, styles.gradientTop, { backgroundColor: gradient[0] }]} />
                  <View style={StyleSheet.absoluteFill} pointerEvents="none">
                    {/* Gradient overlay */}
                    <View style={styles.photoOverlay} />
                  </View>
                  <View style={styles.photoText}>
                    <Text style={styles.cardName} numberOfLines={1}>{cafe.name}</Text>
                  </View>
                  {/* Heart button */}
                  <TouchableOpacity
                    style={styles.heartBtn}
                    onPress={() => toggle(cafe.id)}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="heart" size={13} color="#fff" />
                  </TouchableOpacity>
                </View>

                {/* Info row */}
                <View style={styles.info}>
                  <View style={[styles.tag, tag.style === 'sun' ? styles.tagSun : tag.style === 'later' ? styles.tagLater : styles.tagClosed]}>
                    <Text style={[styles.tagText, tag.style === 'sun' ? styles.tagTextSun : styles.tagTextMuted]}>
                      {tag.label}
                    </Text>
                  </View>
                  {open.isOpen && open.closesAt && (
                    <Text style={styles.openText}>Open until {open.closesAt}</Text>
                  )}
                  {!open.isOpen && open.opensAt && (
                    <Text style={styles.openText}>Opens at {open.opensAt}</Text>
                  )}
                </View>
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
    paddingHorizontal: 26,
    paddingTop: 16,
    paddingBottom: 20,
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

  // Grid
  grid: {
    paddingHorizontal: 20,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  card: {
    width: '47.5%',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#fff',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.09, shadowRadius: 10 },
      android: { elevation: 3 },
    }),
  },
  cardDim: {
    opacity: 0.55,
  },
  photo: {
    height: 120,
    justifyContent: 'flex-end',
  },
  gradientTop: {
    opacity: 0.6,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  photoOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
    // Simulate gradient to bottom
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    // Use a semi-transparent bottom mask
    background: 'linear-gradient(to bottom, transparent 20%, rgba(14,12,10,0.72) 100%)',
  },
  photoText: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 9,
    // Bottom gradient overlay
    backgroundColor: 'rgba(0,0,0,0.32)',
    paddingTop: 24,
  },
  cardName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
    lineHeight: 15,
    marginBottom: 1,
  },
  cardArea: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.6)',
  },
  heartBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 26,
    height: 26,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    backgroundColor: '#fff',
    padding: 9,
    gap: 3,
  },
  tag: {
    alignSelf: 'flex-start',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 20,
  },
  tagSun: { backgroundColor: '#FEF3E2' },
  tagLater: { backgroundColor: '#F3F1EE' },
  tagClosed: { backgroundColor: '#F3F1EE' },
  tagText: { fontSize: 10, fontWeight: '500' },
  tagTextSun: { color: '#E8931A' },
  tagTextMuted: { color: '#9A9690' },
  openText: {
    fontSize: 10,
    color: '#C0BCB8',
  },

  // Empty state
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
    fontSize: 13,
    color: '#B8B4AF',
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 28,
    maxWidth: 240,
  },
  browseBtn: {
    backgroundColor: '#1C1B19',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 30,
  },
  browseBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
  },
});
