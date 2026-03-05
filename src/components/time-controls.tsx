/**
 * Time controls overlay
 *
 * Renders as a floating bottom panel with:
 *  - Shadow on/off toggle
 *  - Current date/time display
 *  - Hour step buttons (−1h / +1h)
 *  - "Now" reset button
 *  - A manual hour slider (drag left/right across the bar)
 *
 * The component is purely presentational – all state lives in the parent.
 */

import React, { useCallback, useRef } from 'react';
import {
  GestureResponderEvent,
  LayoutChangeEvent,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TimeControlsProps {
  date: Date;
  shadowsEnabled: boolean;
  sunDescription: string;
  buildingCount: number;
  isLoading: boolean;
  onDateChange: (newDate: Date) => void;
  onToggleShadows: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function padTwo(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatTime(date: Date): string {
  return `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function addHours(date: Date, hours: number): Date {
  const next = new Date(date);
  next.setHours(next.getHours() + hours);
  return next;
}

/** Convert slider X position (0–1) to hour (0–23). */
function sliderXToHour(fraction: number): number {
  return Math.round(Math.min(Math.max(fraction, 0), 1) * 23);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TimeControls({
  date,
  shadowsEnabled,
  sunDescription,
  buildingCount,
  isLoading,
  onDateChange,
  onToggleShadows,
}: TimeControlsProps) {
  const sliderWidth = useRef(0);

  const handleStepHour = useCallback(
    (delta: number) => onDateChange(addHours(date, delta)),
    [date, onDateChange],
  );

  const handleResetNow = useCallback(() => onDateChange(new Date()), [onDateChange]);

  // Slider touch handlers
  const handleSliderLayout = useCallback((e: LayoutChangeEvent) => {
    sliderWidth.current = e.nativeEvent.layout.width;
  }, []);

  const handleSliderTouch = useCallback(
    (e: GestureResponderEvent) => {
      if (sliderWidth.current === 0) return;
      const fraction = e.nativeEvent.locationX / sliderWidth.current;
      const hour = sliderXToHour(fraction);
      const next = new Date(date);
      next.setHours(hour, 0, 0, 0);
      onDateChange(next);
    },
    [date, onDateChange],
  );

  const hourFraction = date.getHours() / 23;

  return (
    <View style={styles.container}>
      {/* Status row */}
      <View style={styles.statusRow}>
        <Text style={styles.statusText} numberOfLines={1}>
          {isLoading ? 'Loading buildings…' : `${buildingCount} buildings`}
        </Text>
        <Text style={styles.statusText} numberOfLines={1}>
          {sunDescription}
        </Text>
      </View>

      {/* Hour slider */}
      <View
        style={styles.sliderTrack}
        onLayout={handleSliderLayout}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={handleSliderTouch}
        onResponderMove={handleSliderTouch}
      >
        <View style={[styles.sliderFill, { width: `${hourFraction * 100}%` }]} />
        <View style={[styles.sliderThumb, { left: `${hourFraction * 100}%` }]} />
        {/* Hour labels */}
        <Text style={[styles.sliderLabel, { left: 2 }]}>0h</Text>
        <Text style={[styles.sliderLabel, { left: '50%', transform: [{ translateX: -8 }] }]}>
          12h
        </Text>
        <Text style={[styles.sliderLabel, { right: 2 }]}>23h</Text>
      </View>

      {/* Control row */}
      <View style={styles.controlRow}>
        {/* Shadow toggle */}
        <TouchableOpacity
          style={[styles.toggleBtn, shadowsEnabled && styles.toggleBtnActive]}
          onPress={onToggleShadows}
          activeOpacity={0.7}
        >
          <Text style={[styles.toggleText, shadowsEnabled && styles.toggleTextActive]}>
            {shadowsEnabled ? 'Shadows ON' : 'Shadows OFF'}
          </Text>
        </TouchableOpacity>

        {/* Hour steppers */}
        <View style={styles.stepperRow}>
          <TouchableOpacity
            style={styles.stepBtn}
            onPress={() => handleStepHour(-1)}
            activeOpacity={0.7}
          >
            <Text style={styles.stepBtnText}>−1h</Text>
          </TouchableOpacity>

          <View style={styles.timePill}>
            <Text style={styles.timeText}>{formatTime(date)}</Text>
            <Text style={styles.dateText}>{formatDate(date)}</Text>
          </View>

          <TouchableOpacity
            style={styles.stepBtn}
            onPress={() => handleStepHour(1)}
            activeOpacity={0.7}
          >
            <Text style={styles.stepBtnText}>+1h</Text>
          </TouchableOpacity>
        </View>

        {/* Reset to now */}
        <TouchableOpacity style={styles.nowBtn} onPress={handleResetNow} activeOpacity={0.7}>
          <Text style={styles.nowBtnText}>Now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const SHADOW_CARD = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.15,
  shadowRadius: 8,
  elevation: 6,
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 32,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 16,
    padding: 12,
    gap: 10,
    ...SHADOW_CARD,
  },

  // Status
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statusText: {
    fontSize: 11,
    color: '#666',
    flexShrink: 1,
  },

  // Slider
  sliderTrack: {
    height: 28,
    backgroundColor: '#e0e0e0',
    borderRadius: 14,
    overflow: 'visible',
    justifyContent: 'center',
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#FFB300',
    borderRadius: 14,
  },
  sliderThumb: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#FFB300',
    top: 3,
    marginLeft: -11,
    ...SHADOW_CARD,
  },
  sliderLabel: {
    position: 'absolute',
    fontSize: 9,
    color: '#999',
    bottom: -14,
  },

  // Controls
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },

  // Toggle
  toggleBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: '#ccc',
    backgroundColor: '#f5f5f5',
  },
  toggleBtnActive: {
    borderColor: '#1565C0',
    backgroundColor: '#E3F2FD',
  },
  toggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#888',
  },
  toggleTextActive: {
    color: '#1565C0',
  },

  // Time stepper
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stepBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
  },
  stepBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
  },
  timePill: {
    alignItems: 'center',
    minWidth: 64,
  },
  timeText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a1a',
    letterSpacing: 1,
  },
  dateText: {
    fontSize: 10,
    color: '#888',
    marginTop: -2,
  },

  // Now button
  nowBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#FFB300',
  },
  nowBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },
});
