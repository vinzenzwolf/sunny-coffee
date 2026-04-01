import * as Location from 'expo-location';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/auth-context';
import { useLocationSettings } from '../context/location-settings-context';

type Props = {
  topInset: number;
  bottomInset: number;
};

// ---------------------------------------------------------------------------
// Logged-in profile view
// ---------------------------------------------------------------------------

function ProfileLoggedIn({ topInset, bottomInset }: Props) {
  const { user, signOut } = useAuth();
  const { useMyLocation, setUseMyLocation } = useLocationSettings();
  const [updatingLocationSetting, setUpdatingLocationSetting] = useState(false);

  const displayName = user?.user_metadata?.full_name ?? user?.email?.split('@')[0] ?? 'User';
  const avatarLetter = displayName.charAt(0).toUpperCase();
  const handleUseMyLocationChange = async (enabled: boolean) => {
    if (updatingLocationSetting) return;
    setUpdatingLocationSetting(true);
    try {
      if (enabled) {
        let { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') {
          const req = await Location.requestForegroundPermissionsAsync();
          status = req.status;
        }
        if (status !== 'granted') {
          await setUseMyLocation(false);
          return;
        }
      }
      await setUseMyLocation(enabled);
    } finally {
      setUpdatingLocationSetting(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: topInset }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: bottomInset + 24 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>
            Your <Text style={styles.headerItalic}>profile</Text>
          </Text>
        </View>

        {/* Name card */}
        <View style={styles.card}>
          <View style={styles.avatarBox}>
            <Text style={styles.avatarLetter}>{avatarLetter}</Text>
          </View>
          <View style={styles.nameInfo}>
            <Text style={styles.nameValue}>{displayName}</Text>
            <Text style={styles.nameHint}>{user?.email ?? 'Signed in with Google'}</Text>
          </View>
        </View>

        {/* Location section */}
        <Text style={styles.sectionLabel}>Location</Text>
        <View style={styles.group}>
          <View style={styles.row}>
            <View style={[styles.rowIcon, { backgroundColor: '#EEF4FF' }]}>
              <Ionicons name="location-outline" size={18} color="#5080D0" />
            </View>
            <View style={styles.rowLabel}>
              <Text style={styles.rowTitle}>City</Text>
              <Text style={styles.rowSub}>Used for sun calculations</Text>
            </View>
            <Text style={styles.rowValue}>Copenhagen</Text>
            <Ionicons name="chevron-forward" size={16} color="#1C1B19" style={styles.chevron} />
          </View>
          <View style={[styles.row, styles.rowBorder]}>
            <View style={[styles.rowIcon, { backgroundColor: '#EEF4FF' }]}>
              <Ionicons name="navigate-outline" size={18} color="#5080D0" />
            </View>
            <View style={styles.rowLabel}>
              <Text style={styles.rowTitle}>Use my location</Text>
              <Text style={styles.rowSub}>Auto-detect when app opens</Text>
            </View>
            <Switch
              value={useMyLocation}
              onValueChange={handleUseMyLocationChange}
              disabled={updatingLocationSetting}
              trackColor={{ false: '#E0DDD9', true: '#1C1B19' }}
              thumbColor="#fff"
              ios_backgroundColor="#E0DDD9"
            />
          </View>
        </View>

        {/* Account section */}
        <Text style={styles.sectionLabel}>Account</Text>
        <View style={styles.group}>
          <TouchableOpacity style={styles.row} onPress={signOut} activeOpacity={0.7}>
            <View style={[styles.rowIcon, { backgroundColor: '#FFF0EE' }]}>
              <Ionicons name="log-out-outline" size={18} color="#C0392B" />
            </View>
            <View style={styles.rowLabel}>
              <Text style={[styles.rowTitle, { color: '#C0392B' }]}>Sign out</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* About section */}
        <Text style={styles.sectionLabel}>About</Text>
        <View style={styles.aboutCard}>
          <Text style={styles.aboutLogo}>
            sunny <Text style={styles.aboutLogoItalic}>coffee</Text>
          </Text>
          <Text style={styles.aboutVersion}>Version 1.0.0 · Made in Copenhagen</Text>
          <View style={styles.aboutLinks}>
            <Text style={styles.aboutLink}>Privacy</Text>
            <Text style={styles.aboutLink}>Terms</Text>
            <Text style={styles.aboutLink}>Feedback</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Logged-out / login view
// ---------------------------------------------------------------------------

function ProfileLogin({ topInset, bottomInset }: Props) {
  const { signInWithGoogle } = useAuth();
  const [signingIn, setSigningIn] = useState(false);

  const handleGoogle = async () => {
    setSigningIn(true);
    try {
      await signInWithGoogle();
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: topInset }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.loginContent, { paddingBottom: bottomInset + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>
            Your <Text style={styles.headerItalic}>profile</Text>
          </Text>
        </View>

        {/* Hero */}
        <View style={styles.loginHero}>
          <View style={styles.loginAvatarBox}>
            <Text style={styles.loginAvatarEmoji}>☀️</Text>
          </View>
          <Text style={styles.loginTitle}>Sign in to save your{'\n'}favourite sun spots</Text>
          <Text style={styles.loginSub}>Access your saved cafés across devices.</Text>
        </View>

        {/* Google button */}
        <TouchableOpacity
          style={[styles.socialBtn, styles.googleBtn]}
          onPress={handleGoogle}
          activeOpacity={0.85}
          disabled={signingIn}
        >
          {signingIn ? (
            <ActivityIndicator color="#333" size="small" />
          ) : (
            <>
              <Ionicons name="logo-google" size={18} color="#333" style={styles.socialIcon} />
              <Text style={[styles.socialText, { color: '#333' }]}>Continue with Google</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Apple placeholder */}
        <TouchableOpacity
          style={[styles.socialBtn, styles.appleBtn]}
          activeOpacity={0.85}
          disabled
        >
          <Ionicons name="logo-apple" size={18} color="#fff" style={styles.socialIcon} />
          <Text style={[styles.socialText, { color: '#fff' }]}>Continue with Apple</Text>
        </TouchableOpacity>

        <Text style={styles.legalText}>
          By continuing you agree to our Terms of Service and Privacy Policy.
        </Text>

        {/* About */}
        <Text style={styles.sectionLabel}>About</Text>
        <View style={styles.aboutCard}>
          <Text style={styles.aboutLogo}>
            sunny <Text style={styles.aboutLogoItalic}>coffee</Text>
          </Text>
          <Text style={styles.aboutVersion}>Version 1.0.0 · Made in Copenhagen</Text>
          <View style={styles.aboutLinks}>
            <Text style={styles.aboutLink}>Privacy</Text>
            <Text style={styles.aboutLink}>Terms</Text>
            <Text style={styles.aboutLink}>Feedback</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export default function ProfileTab(props: Props) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color="#F5A623" size="large" />
      </View>
    );
  }

  return user ? <ProfileLoggedIn {...props} /> : <ProfileLogin {...props} />;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#F5F3F0',
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    flex: 1,
  },
  loginContent: {
    paddingHorizontal: 0,
  },

  // Header
  header: {
    paddingHorizontal: 26,
    paddingTop: 16,
    paddingBottom: 20,
  },
  headerTitle: {
    fontSize: 32,
    fontWeight: '300',
    color: '#1C1B19',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    letterSpacing: -0.3,
  },
  headerItalic: {
    fontStyle: 'italic',
    color: '#F5A623',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },

  // Name card
  card: {
    marginHorizontal: 20,
    marginBottom: 8,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8 },
      android: { elevation: 2 },
    }),
  },
  avatarBox: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: '#F5A623',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
  },
  nameInfo: {
    flex: 1,
  },
  nameValue: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1C1B19',
    marginBottom: 2,
  },
  nameHint: {
    fontSize: 11,
    color: '#B8B4AF',
  },

  // Section label
  sectionLabel: {
    paddingHorizontal: 26,
    paddingTop: 18,
    paddingBottom: 8,
    fontSize: 10,
    fontWeight: '600',
    color: '#C0BCB8',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // Group
  group: {
    marginHorizontal: 20,
    marginBottom: 8,
    backgroundColor: '#fff',
    borderRadius: 16,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8 },
      android: { elevation: 2 },
    }),
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: '#F3F1EE',
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1C1B19',
    marginBottom: 1,
  },
  rowSub: {
    fontSize: 11,
    color: '#B8B4AF',
  },
  rowValue: {
    fontSize: 12,
    color: '#B8B4AF',
    marginRight: 4,
  },
  chevron: {
    opacity: 0.3,
  },

  // About card
  aboutCard: {
    marginHorizontal: 20,
    marginBottom: 8,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 18,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8 },
      android: { elevation: 2 },
    }),
  },
  aboutLogo: {
    fontSize: 18,
    fontWeight: '300',
    color: '#1C1B19',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    marginBottom: 4,
  },
  aboutLogoItalic: {
    fontStyle: 'italic',
    color: '#F5A623',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  aboutVersion: {
    fontSize: 11,
    color: '#C0BCB8',
    marginBottom: 14,
  },
  aboutLinks: {
    flexDirection: 'row',
    gap: 16,
  },
  aboutLink: {
    fontSize: 12,
    color: '#9A9690',
    fontWeight: '500',
  },

  // Login view
  loginHero: {
    alignItems: 'center',
    paddingHorizontal: 26,
    paddingVertical: 24,
  },
  loginAvatarBox: {
    width: 72,
    height: 72,
    borderRadius: 22,
    backgroundColor: '#FEF3E2',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  loginAvatarEmoji: {
    fontSize: 36,
  },
  loginTitle: {
    fontSize: 24,
    fontWeight: '300',
    color: '#1C1B19',
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    marginBottom: 10,
    lineHeight: 32,
  },
  loginSub: {
    fontSize: 14,
    color: '#B8B4AF',
    textAlign: 'center',
  },
  socialBtn: {
    marginHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 14,
    marginBottom: 10,
  },
  googleBtn: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E8E4DF',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4 },
      android: { elevation: 1 },
    }),
  },
  appleBtn: {
    backgroundColor: '#1C1B19',
    opacity: 0.35,
  },
  socialIcon: {
    marginRight: 10,
  },
  socialText: {
    fontSize: 15,
    fontWeight: '600',
  },
  legalText: {
    marginHorizontal: 26,
    marginTop: 16,
    marginBottom: 4,
    fontSize: 11,
    color: '#C0BCB8',
    textAlign: 'center',
    lineHeight: 17,
  },
});
