import { CameraView, useCameraPermissions } from 'expo-camera';
import { BlurView } from 'expo-blur';
import { ImageManipulator, SaveFormat, manipulateAsync } from 'expo-image-manipulator';
import { useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { extractInvoice } from '../services/api';
import { useAppState } from '../context/StateContext';

export default function CameraScreen() {
  const router = useRouter();
  const { state, updateState, clearState } = useAppState();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<any>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  const handleCapture = async () => {
    if (isCapturing || !cameraRef.current) return;
    setIsCapturing(true);

    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: false });
      const manipResult = await manipulateAsync(
        photo.uri,
        [{ resize: { width: 1080 } }],
        { compress: 0.8, format: SaveFormat.JPEG, base64: true }
      );

      if (!manipResult.base64) throw new Error("Base64 extraction failed");

      // Extract via AI
      const extractedItems = await extractInvoice(manipResult.base64, "image/jpeg", state.token!);
      
      const updates: any = {
        pending: extractedItems.items.map(it => ({
          ...it,
          BelongsTo: state.people[0] || "Me"
        }))
      };
      if (extractedItems.shopName) updates.shopName = extractedItems.shopName;
      if (extractedItems.purchaseDate) updates.purchaseDate = extractedItems.purchaseDate;
      
      updateState(updates);

      router.push('/receipt');
    } catch (err: any) {
      Alert.alert('Extraction Failed', err.message);
    } finally {
      setIsCapturing(false);
    }
  };

  const handleBack = () => {
    router.back();
  };

  if (!permission) return <View style={styles.center} />;
  
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.permText}>Camera access is required to scan receipts.</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Enable Camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />

      {/* Top glass header */}
      <BlurView intensity={100} tint="dark" style={styles.topSection}>
        <View style={styles.topInner}>
          <Text style={styles.title}>ShopShare</Text>
          <Text style={styles.subtitle}>Position the receipt in the frame</Text>
        </View>
      </BlurView>

      <View style={styles.frameArea} pointerEvents="none">
        <BlurView intensity={100} tint="dark" style={styles.maskH} />
        <View style={styles.frameRow}>
          <BlurView intensity={100} tint="dark" style={styles.maskV} />
          <View style={styles.frame} />
          <BlurView intensity={100} tint="dark" style={styles.maskV} />
        </View>
        <BlurView intensity={100} tint="dark" style={styles.maskH} />
      </View>

      {/* Bottom glass bar */}
      <BlurView intensity={100} tint="dark" style={styles.bottomSection}>
        <View style={styles.glassLine} />
        <View style={styles.bottomInner}>
          <TouchableOpacity
            style={styles.sideBtn}
            onPress={() => router.push('/receipt')}
            disabled={isCapturing}
          >
            <Text style={styles.sideBtnIcon}>🧾</Text>
            <Text style={styles.sideBtnLabel}>Receipt</Text>
            {state.items.length > 0 && (
              <View style={styles.badge}><Text style={styles.badgeTxt}>{state.items.length}</Text></View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.captureBtn, isCapturing && styles.captureBtnBusy]}
            onPress={handleCapture}
            disabled={isCapturing}
          >
            {isCapturing ? (
              <ActivityIndicator color="#1a1a1a" size="large" />
            ) : (
              <View style={styles.captureRing}>
                <View style={styles.captureCore} />
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.sideBtn}
            onPress={handleBack}
            disabled={isCapturing}
          >
            <Text style={styles.sideBtnIcon}>✕</Text>
            <Text style={styles.sideBtnLabel}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  topSection: { overflow: 'hidden' },
  topInner: {
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 20,
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.25)',
  },
  title: { color: '#ff8a00', fontSize: 24, fontWeight: 'bold', marginBottom: 4 },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: 15 },
  frameArea: { flex: 1 },
  maskH: { flex: 1, overflow: 'hidden' },
  frameRow: { flexDirection: 'row' },
  maskV: { width: '10%', overflow: 'hidden' },
  frame: {
    flex: 1,
    aspectRatio: 3 / 4,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#ff8a00',
  },
  bottomSection: { overflow: 'hidden' },
  glassLine: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.25)' },
  bottomInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 36,
    paddingTop: 24,
    paddingBottom: 48,
  },
  sideBtn: { width: 64, alignItems: 'center', gap: 4 },
  sideBtnIcon: { fontSize: 24 },
  sideBtnLabel: { color: '#fff', fontSize: 12, fontWeight: '600' },
  badge: {
    position: 'absolute', top: -5, right: 5, backgroundColor: 'red', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2
  },
  badgeTxt: { color: '#fff', fontSize: 10, fontWeight: 'bold' },
  captureBtn: { width: 76, height: 76, borderRadius: 38, backgroundColor: '#fff', justifyContent: 'center', alignItems: 'center' },
  captureBtnBusy: { backgroundColor: 'rgba(255,255,255,0.6)' },
  captureRing: { width: 68, height: 68, borderRadius: 34, borderWidth: 3, borderColor: '#ddd', justifyContent: 'center', alignItems: 'center' },
  captureCore: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#ff8a00' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1a1a1a' },
  permText: { color: '#fff', marginBottom: 20 },
  permBtn: { backgroundColor: '#ff8a00', padding: 15, borderRadius: 8 },
  permBtnText: { color: '#fff', fontWeight: 'bold' }
});
