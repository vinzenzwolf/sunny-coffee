import { Platform, StyleSheet, Text, View } from 'react-native';
import MapView, { UrlTile } from 'react-native-maps';

export default function HomeScreen() {
  if (Platform.OS === 'web') {
    return (
      <View style={styles.webContainer}>
        <Text style={styles.webText}>Map is available on iOS / Android.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        mapType="none"
        initialRegion={{
          latitude: 48.137154,
          longitude: 11.576124,
          latitudeDelta: 0.15,
          longitudeDelta: 0.15,
        }}
        maxZoomLevel={18}
        showsCompass={false}
        showsScale={false}
        toolbarEnabled={false}
        showsPointsOfInterest={false}
      >
        <UrlTile
          urlTemplate="https://a.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png"
          maximumZ={19}
          flipY={false}
          tileSize={256}
          shouldReplaceMapContent
        />
      </MapView>

      
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f3f4f6',
  },
  webText: {
    fontSize: 14,
    color: '#111827',
  },
  map: {
    ...StyleSheet.absoluteFillObject,
  },
  attribution: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.75)',
  },
  attributionText: {
    fontSize: 11,
    color: '#111827',
  },
});
