import React, { useMemo } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { Cafe } from '../types';
import { getOpenUntilToday } from '../utils/opening-hours';

type ExploreCard = {
  id: string;
  name: string;
  area: string;
  tag: string;
  open: string;
  gradient: readonly [string, string, string];
  dim?: boolean;
};

type ExploreTabProps = {
  topInset: number;
  bottomInset: number;
  cafes: Cafe[];
};

const SUN_NOW_GRADIENTS: readonly (readonly [string, string, string])[] = [
  ['#F0C87A', '#D4944A', '#B06828'],
  ['#E8D4A0', '#C4A060', '#9A7038'],
  ['#F4D890', '#D8A848', '#AA7C28'],
  ['#DCC890', '#B89450', '#8C6A28'],
];

function normalizeExploreCards(cafes: Cafe[]): { sunNow: ExploreCard[]; sunLater: ExploreCard[] } {
  const nowCards: ExploreCard[] = cafes
    .map((cafe, idx) => {
      const openStatus = getOpenUntilToday(cafe.metadata?.openingHours);
      if (!openStatus.isOpen || !openStatus.closesAt) return null;
      if (cafe.metadata?.inSunNow !== true) return null;
      return {
        id: cafe.id,
        name: cafe.name || 'Cafe',
        area: cafe.area || 'Copenhagen',
        tag: '☀ In the sun now',
        open: `Open until ${openStatus.closesAt}`,
        gradient: SUN_NOW_GRADIENTS[idx % SUN_NOW_GRADIENTS.length],
        distanceMeters: cafe.metadata?.distanceMeters,
      };
    })
    .filter((card): card is ExploreCard & { distanceMeters?: number } => card !== null)
    .sort((a, b) => {
      const aDist = typeof a.distanceMeters === 'number' ? a.distanceMeters : Number.POSITIVE_INFINITY;
      const bDist = typeof b.distanceMeters === 'number' ? b.distanceMeters : Number.POSITIVE_INFINITY;
      return aDist - bDist;
    })
    .slice(0, 20)
    .map(({ distanceMeters: _distanceMeters, ...card }) => card);

  const laterCards: ExploreCard[] = [];

  return { sunNow: nowCards, sunLater: laterCards };
}

function ExploreCardItem({
  card,
  isLater,
}: {
  card: ExploreCard;
  isLater: boolean;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      style={[styles.exploreCard, card.dim && styles.exploreCardDim]}
    >
      <View style={styles.explorePhoto}>
        <View
          style={[
            styles.explorePhotoBg,
            {
              backgroundColor: card.gradient[1],
              borderColor: card.gradient[0],
            },
          ]}
        />
        <View style={styles.explorePhotoShade} />
        <View style={styles.exploreOverlay}>
          <Text style={styles.exploreName}>{card.name}</Text>
          <Text style={styles.exploreArea}>{card.area}</Text>
        </View>
      </View>
      <View style={styles.exploreInfo}>
        <Text style={[styles.exploreTag, isLater ? styles.exploreTagLater : styles.exploreTagSun]}>
          {card.tag}
        </Text>
        <Text style={styles.exploreOpen}>{card.open}</Text>
      </View>
    </TouchableOpacity>
  );
}

export default function ExploreTab({ topInset, bottomInset, cafes }: ExploreTabProps) {
  const { sunNow, sunLater } = useMemo(() => normalizeExploreCards(cafes), [cafes]);

  return (
    <View style={styles.explorePanel}>
      <ScrollView
        style={styles.exploreScroll}
        contentContainerStyle={[
          styles.exploreContent,
          { paddingTop: topInset + 20, paddingBottom: bottomInset + 20 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.exploreHeader}>
          <View style={styles.exploreSunCount}>
            <Text style={styles.exploreSunNumber}>{sunNow.length}</Text>
            <Text style={styles.exploreSunLabel}>
              cafés <Text style={styles.exploreSunLabelAccent}>in the sun</Text> right now
            </Text>
          </View>
          <View style={styles.exploreBadge}>
            <View style={styles.exploreBadgeDot} />
            <Text style={styles.exploreBadgeText}>Personally tested by us</Text>
          </View>
        </View>

        <View style={styles.exploreGrid}>
          {sunNow.map((card) => (
            <ExploreCardItem key={card.id} card={card} isLater={false} />
          ))}
        </View>

        {sunNow.length === 0 && (
          <Text style={styles.exploreEmptyText}>No cafés open right now</Text>
        )}

        {sunLater.length > 0 && (
          <>
            <View style={styles.exploreDivider}>
              <Text style={styles.exploreDividerLabel}>Sun later</Text>
              <View style={styles.exploreDividerLine} />
            </View>

            <View style={styles.exploreGrid}>
              {sunLater.map((card) => (
                <ExploreCardItem key={card.id} card={card} isLater />
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  explorePanel: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#F5F3F0',
    zIndex: 12,
  },
  exploreScroll: {
    flex: 1,
  },
  exploreContent: {
    minHeight: '100%',
  },
  exploreHeader: {
    paddingHorizontal: 24,
    paddingBottom: 20,
  },
  exploreSunCount: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 6,
    gap: 8,
  },
  exploreSunNumber: {
    fontSize: 52,
    lineHeight: 52,
    fontWeight: '300',
    color: '#1C1B19',
    letterSpacing: -1,
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  exploreSunLabel: {
    paddingBottom: 4,
    fontSize: 13,
    color: '#B8B4AF',
    fontWeight: '400',
  },
  exploreSunLabelAccent: {
    color: '#F5A623',
    fontStyle: 'italic',
  },
  exploreBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    backgroundColor: '#EDEAE6',
    borderColor: '#E0DDD9',
    borderWidth: 1,
    borderRadius: 20,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  exploreBadgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#F5A623',
  },
  exploreBadgeText: {
    fontSize: 11,
    color: '#6B6762',
    fontWeight: '400',
  },
  exploreGrid: {
    paddingHorizontal: 20,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 10,
  },
  exploreCard: {
    width: '48.5%',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#fff',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.09,
        shadowRadius: 16,
      },
      android: { elevation: 3 },
    }),
  },
  exploreCardDim: {
    opacity: 0.45,
  },
  explorePhoto: {
    height: 120,
    position: 'relative',
    justifyContent: 'flex-end',
  },
  explorePhotoBg: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    borderRadius: 0,
  },
  explorePhotoShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  exploreOverlay: {
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  exploreName: {
    fontSize: 13,
    lineHeight: 15,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 1,
  },
  exploreArea: {
    fontSize: 10,
    lineHeight: 12,
    color: 'rgba(255,255,255,0.6)',
  },
  exploreInfo: {
    backgroundColor: '#fff',
    paddingHorizontal: 10,
    paddingTop: 9,
    paddingBottom: 10,
    gap: 4,
  },
  exploreTag: {
    alignSelf: 'flex-start',
    borderRadius: 20,
    overflow: 'hidden',
    fontSize: 10,
    fontWeight: '500',
    paddingVertical: 2,
    paddingHorizontal: 7,
  },
  exploreTagSun: {
    backgroundColor: '#FEF3E2',
    color: '#E8931A',
  },
  exploreTagLater: {
    backgroundColor: '#F3F1EE',
    color: '#9A9690',
  },
  exploreOpen: {
    fontSize: 10,
    color: '#C0BCB8',
  },
  exploreDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 10,
  },
  exploreDividerLabel: {
    textTransform: 'uppercase',
    fontSize: 10,
    letterSpacing: 0.8,
    fontWeight: '600',
    color: '#C8C4BF',
  },
  exploreDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#EAE7E3',
  },
  exploreEmptyText: {
    marginTop: 16,
    textAlign: 'center',
    fontSize: 13,
    color: '#9A9690',
  },
});
