import React, { useCallback, useRef, useState } from 'react';
import {
  GestureResponderEvent,
  LayoutChangeEvent,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';

interface TimeControlsProps {
  date: Date;
  buildingCount: number;
  isLoading: boolean;
  bottom: number;
  onDateChange: (newDate: Date) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

const TICK_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

function padTwo(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatTime(date: Date): string {
  return `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;
}

function sliderXToMinutes(fraction: number): number {
  return Math.round(Math.min(Math.max(fraction, 0), 1) * 1439);
}

export function TimeControls({
  date,
  bottom,
  onDateChange,
  onScrubStart,
  onScrubEnd,
}: TimeControlsProps) {
  const sliderWidth = useRef(0);
  const lastSliderMinutes = useRef<number | null>(null);
  const lastSentAtMs = useRef(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubMinutes, setScrubMinutes] = useState<number | null>(null);

  const handleSliderLayout = useCallback((e: LayoutChangeEvent) => {
    sliderWidth.current = e.nativeEvent.layout.width;
  }, []);

  const handleSliderTouch = useCallback(
    (e: GestureResponderEvent) => {
      if (sliderWidth.current === 0) return;
      const fraction = e.nativeEvent.locationX / sliderWidth.current;
      const minutes = sliderXToMinutes(fraction);
      if (lastSliderMinutes.current === minutes) return;
      lastSliderMinutes.current = minutes;
      setScrubMinutes(minutes);

      const next = new Date(date);
      next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      const now = Date.now();
      if (now - lastSentAtMs.current >= 40) {
        lastSentAtMs.current = now;
        onDateChange(next);
      }
    },
    [date, onDateChange],
  );

  const displayedMinutes = scrubMinutes ?? (date.getHours() * 60 + date.getMinutes());
  const dayFraction = displayedMinutes / 1439;
  const displayedHour = Math.floor(displayedMinutes / 60);

  return (
    <View style={[styles.container, { bottom }]}>
      {/* Header: label left, dot + time right */}
      <View style={styles.head}>
        <Text style={styles.label}>Sun position</Text>
        <View style={styles.val}>
          <View style={styles.dot} />
          <Text style={styles.time}>{formatTime(date)}</Text>
        </View>
      </View>

      {/* Slider */}
      <View
        style={styles.sliderArea}
        onLayout={handleSliderLayout}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => {
          setIsScrubbing(true);
          onScrubStart?.();
          handleSliderTouch(e);
        }}
        onResponderMove={handleSliderTouch}
        onResponderRelease={() => {
          if (scrubMinutes !== null) {
            const next = new Date(date);
            next.setHours(Math.floor(scrubMinutes / 60), scrubMinutes % 60, 0, 0);
            onDateChange(next);
          }
          setIsScrubbing(false);
          setScrubMinutes(null);
          lastSliderMinutes.current = null;
          lastSentAtMs.current = 0;
          onScrubEnd?.();
        }}
        onResponderTerminate={() => {
          setIsScrubbing(false);
          setScrubMinutes(null);
          lastSliderMinutes.current = null;
          lastSentAtMs.current = 0;
          onScrubEnd?.();
        }}
      >
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${dayFraction * 100}%` as `${number}%` }]} />
          <View
            style={[
              styles.thumb,
              isScrubbing && styles.thumbActive,
              { left: `${dayFraction * 100}%` as `${number}%` },
            ]}
          />
        </View>

        <View style={styles.ticks} pointerEvents="none">
          {TICK_HOURS.map((h) => (
            <Text key={h} style={[styles.tick, displayedHour === h && styles.tickActive]}>
              {h}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}

const CARD_SHADOW = Platform.select({
  ios: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.09,
    shadowRadius: 24,
  },
  android: { elevation: 6 },
}) ?? {};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 20,
    right: 20,
    backgroundColor: '#fff',
    borderRadius: 18,
    paddingTop: 14,
    paddingHorizontal: 16,
    paddingBottom: 12,
    ...CARD_SHADOW,
  },

  // Header
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: '#B0ADA8',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  val: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#F5A623',
    ...Platform.select({
      ios: {
        shadowColor: '#F5A623',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.6,
        shadowRadius: 4,
      },
    }),
  },
  time: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1C1B19',
  },

  // Track + ticks share one touch area
  sliderArea: {
    paddingBottom: 2, // ticks sit just below track
  },
  track: {
    height: 4,
    backgroundColor: '#F0EDE9',
    borderRadius: 2,
    overflow: 'visible',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 2,
    backgroundColor: '#F5A623',
  },
  thumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#F5A623',
    borderWidth: 2.5,
    borderColor: '#fff',
    top: -6,
    marginLeft: -8,
    ...Platform.select({
      ios: {
        shadowColor: '#F5A623',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.45,
        shadowRadius: 4,
      },
      android: { elevation: 3 },
    }),
  },
  thumbActive: {
    transform: [{ scale: 1.15 }],
  },
  ticks: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 7,
  },
  tick: {
    fontSize: 9,
    color: '#D8D4CF',
    fontWeight: '500',
    flex: 1,
    textAlign: 'center',
  },
  tickActive: {
    color: '#F5A623',
    fontWeight: '700',
  },
});
