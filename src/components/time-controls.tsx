import React, { useCallback, useRef, useState } from 'react';
import {
  GestureResponderEvent,
  LayoutChangeEvent,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

interface TimeControlsProps {
  date: Date;
  buildingCount: number;
  isLoading: boolean;
  bottom: number;
  sunriseMinutes: number;
  sunsetMinutes: number;
  onDateChange: (newDate: Date) => void;
  onSetNow?: () => void;
  isLive?: boolean;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

const TOOLTIP_WIDTH = 52;

function padTwo(n: number): string {
  return n.toString().padStart(2, '0');
}

function minutesToTimeString(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${padTwo(h)}:${padTwo(m)}`;
}

function sliderXToMinutes(fraction: number, sunriseMin: number, sunsetMin: number): number {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  return Math.round(sunriseMin + clamped * (sunsetMin - sunriseMin));
}

export function TimeControls({
  date,
  bottom,
  sunriseMinutes,
  sunsetMinutes,
  onDateChange,
  onSetNow,
  isLive = true,
  onScrubStart,
  onScrubEnd,
}: TimeControlsProps) {
  const [sliderWidth, setSliderWidth] = useState(0);
  const lastSliderMinutes = useRef<number | null>(null);
  const scrubMinutesRef = useRef<number | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubMinutes, setScrubMinutes] = useState<number | null>(null);

  const handleSliderLayout = useCallback((e: LayoutChangeEvent) => {
    const width = e.nativeEvent.layout.width;
    if (width !== sliderWidth) setSliderWidth(width);
  }, [sliderWidth]);

  const handleSliderTouch = useCallback(
    (e: GestureResponderEvent) => {
      if (sliderWidth === 0) return;
      const fraction = e.nativeEvent.locationX / sliderWidth;
      if (!isFinite(fraction)) return;
      const minutes = sliderXToMinutes(fraction, sunriseMinutes, sunsetMinutes);
      if (!isFinite(minutes)) return;
      if (lastSliderMinutes.current === minutes) return;
      lastSliderMinutes.current = minutes;
      scrubMinutesRef.current = minutes;
      setScrubMinutes(minutes);

      const next = new Date(date);
      next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      if (!isFinite(next.getTime())) return;
      onDateChange(next);
    },
    [date, sunriseMinutes, sunsetMinutes, onDateChange, sliderWidth],
  );

  const rawMinutes = isFinite(date.getTime()) ? date.getHours() * 60 + date.getMinutes() : sunriseMinutes;
  const nowMinutes = (() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  })();
  const stateLabel = isLive ? 'LIVE' : rawMinutes < nowMinutes ? 'PAST' : 'PREVIEW';
  const labelMinutes = scrubMinutes ?? rawMinutes;
  const displayedMinutes = Math.min(Math.max(labelMinutes, sunriseMinutes), sunsetMinutes);
  const range = sunsetMinutes - sunriseMinutes;
  const dayFraction = range > 0 ? (displayedMinutes - sunriseMinutes) / range : 0;
  const tooltipLeft = (() => {
    if (!sliderWidth) return `${dayFraction * 100}%` as `${number}%`;
    const x = dayFraction * sliderWidth;
    const clamped = Math.max(0, Math.min(sliderWidth - TOOLTIP_WIDTH, x - TOOLTIP_WIDTH / 2));
    return clamped;
  })();

  return (
    <View style={[styles.container, { bottom }]}>
      {/* Header: status left, now action right (non-live only) */}
      <View style={styles.head}>
        <View style={[styles.stateBadge, isLive ? styles.stateBadgeLive : styles.stateBadgePreview]}>
          <Text style={[styles.stateBadgeText, isLive ? styles.stateBadgeTextLive : styles.stateBadgeTextPreview]}>
            {stateLabel}
          </Text>
        </View>
        <TouchableOpacity style={[styles.nowBtn, isLive && styles.nowBtnHidden]} onPress={onSetNow} activeOpacity={0.85} disabled={isLive}>
          <Text style={[styles.nowBtnText, isLive && styles.nowBtnTextHidden]}>Now</Text>
        </TouchableOpacity>
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
          const finalMinutes = scrubMinutesRef.current;
          if (finalMinutes !== null && isFinite(finalMinutes)) {
            const next = new Date(date);
            next.setHours(Math.floor(finalMinutes / 60), finalMinutes % 60, 0, 0);
            if (isFinite(next.getTime())) onDateChange(next);
          }
          scrubMinutesRef.current = null;
          setIsScrubbing(false);
          setScrubMinutes(null);
          lastSliderMinutes.current = null;
          onScrubEnd?.();
        }}
        onResponderTerminate={() => {
          scrubMinutesRef.current = null;
          setIsScrubbing(false);
          setScrubMinutes(null);
          lastSliderMinutes.current = null;
          onScrubEnd?.();
        }}
      >
        <View style={styles.track} pointerEvents="none">
          <View style={[styles.thumbTooltip, { left: tooltipLeft }]}>
            <Text style={styles.thumbTooltipText}>{minutesToTimeString(labelMinutes)}</Text>
          </View>
          <View
            style={[
              styles.thumb,
              isScrubbing && styles.thumbActive,
              { left: `${dayFraction * 100}%` as `${number}%` },
            ]}
          />
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
  stateBadge: {
    minHeight: 24,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 0,
    borderWidth: 1,
    justifyContent: 'center',
  },
  stateBadgeLive: {
    backgroundColor: '#FEF3E2',
    borderColor: '#F2C98C',
  },
  stateBadgePreview: {
    backgroundColor: '#F2F0ED',
    borderColor: '#DDD8D1',
  },
  stateBadgeText: {
    fontSize: 10,
    letterSpacing: 0.4,
    fontWeight: '700',
  },
  stateBadgeTextLive: {
    color: '#D88413',
  },
  stateBadgeTextPreview: {
    color: '#8E8880',
  },
  nowBtn: {
    minWidth: 50,
    minHeight: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#DFDAD2',
    backgroundColor: '#F6F3EF',
    paddingHorizontal: 10,
    paddingVertical: 0,
  },
  nowBtnHidden: {
    opacity: 0,
  },
  nowBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#5E5952',
  },
  nowBtnTextHidden: {
    color: 'transparent',
  },

  // Track + ticks share one touch area
  sliderArea: {
    marginTop: 36,
    paddingBottom: 2,
  },
  track: {
    height: 18,
    backgroundColor: '#ECE8E2',
    borderRadius: 9,
    overflow: 'visible',
  },
  thumb: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#1C1B19',
    top: -2,
    marginLeft: -11,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
      },
      android: { elevation: 4 },
    }),
  },
  thumbTooltip: {
    position: 'absolute',
    bottom: 28,
    width: TOOLTIP_WIDTH,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: '#1C1B19',
    alignItems: 'center',
  },
  thumbTooltipText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#fff',
  },
  thumbActive: {
    transform: [{ scale: 1.15 }],
  },
});
