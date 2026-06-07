import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Image, Platform, Linking, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useAppState } from '../context/StateContext';
import { extractInvoice, uploadToS3 } from '../services/api';
import { BlurView } from 'expo-blur';

export default function DashboardScreen() {
  const router = useRouter();
  const { state, updateState, refreshState } = useAppState();
  const [isProcessing, setIsProcessing] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    if (refreshState) {
      await refreshState();
    }
    setRefreshing(false);
  }, [refreshState]);

  const handlePickImage = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      base64: true,
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0].base64) {
      processFile(result.assets[0].base64, "image/jpeg");
    }
  };

  const handleUploadS3 = async () => {
    try {
      // Fix #13: Only accept supported MIME types to prevent confusing errors
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/png', 'image/jpeg', 'application/pdf']
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      const file = result.assets[0];
      
      setIsProcessing(true);
      await uploadToS3(file.uri, file.name, file.mimeType || 'application/octet-stream', state.token!);
      
      const newUpload = { key: Date.now().toString(), filename: file.name, uploadedAt: Date.now() };
      updateState({ uploads: [...state.uploads, newUpload] });
      
      Alert.alert("Success", "File uploaded to S3!");
    } catch (err: any) {
      Alert.alert("Upload Failed", err.message);
    } finally {
      setIsProcessing(false);
    }
  };

  const processFile = async (base64: string, mimeType: string) => {
    setIsProcessing(true);
    try {
      const extractedData = await extractInvoice(base64, mimeType, state.token!);
      const items = Array.isArray(extractedData) ? extractedData : (extractedData.items || []);
      const shopName = extractedData.shopName || "";

      updateState({
        ...(shopName ? { shopName } : {}),
        pending: items.map(it => ({
          ...it,
          BelongsTo: state.people[0] || "Me"
        }))
      });
      router.push('/receipt');
    } catch (err: any) {
      Alert.alert('Extraction Failed', err.message);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.container}>
        {/* Header */}
      <BlurView intensity={100} tint="dark" style={styles.header}>
        <View style={styles.headerTop}>
          <Image source={require('../assets/shopshare_icon.png')} style={styles.logo} />
          <Text style={styles.title}>ShopShare</Text>
          <TouchableOpacity onPress={() => router.push('/settings')} style={styles.settingsBtn}>
            <Text style={styles.settingsIcon}>⚙️</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.subtitle}>Welcome, {state.fullName || 'User'}</Text>
      </BlurView>

      <ScrollView 
        style={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ff8a00" />
        }
      >
        <View style={styles.grid}>
          <TouchableOpacity style={styles.card} onPress={() => router.push('/camera')}>
            <Text style={styles.cardIcon}>📷</Text>
            <Text style={styles.cardTitle}>Scan Receipt</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.card} onPress={handlePickImage}>
            <Text style={styles.cardIcon}>🖼️</Text>
            <Text style={styles.cardTitle}>Upload Image</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.card} onPress={() => router.push('/receipt')}>
            <Text style={styles.cardIcon}>✍️</Text>
            <Text style={styles.cardTitle}>Add Manually</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.card} onPress={handleUploadS3}>
            <Text style={styles.cardIcon}>☁️</Text>
            <Text style={styles.cardTitle}>Upload to S3</Text>
          </TouchableOpacity>
        </View>

        {isProcessing && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#ff8a00" />
            <Text style={styles.loadingText}>Processing...</Text>
          </View>
        )}

        <View style={styles.historySection}>
          <Text style={styles.sectionTitle}>Scanned History</Text>
          {!state.history || state.history.length === 0 ? (
            <Text style={styles.emptyText}>No scanned history yet.</Text>
          ) : (
            <>
              {state.history.slice(0, showAllHistory ? state.history.length : 5).map((h) => (
                <TouchableOpacity 
                  key={h.id} 
                  style={styles.historyCard}
                  onPress={() => setExpandedHistoryId(expandedHistoryId === h.id ? null : h.id)}
                >
                  <View style={styles.historyRow}>
                    <Text style={styles.historyName} numberOfLines={1}>{h.shopName}</Text>
                    <Text style={styles.historyDate}>
                      {new Date(h.date).toLocaleDateString()} - ${(h.total || 0).toFixed(2)}
                    </Text>
                  </View>
                  {expandedHistoryId === h.id && h.items && h.items.length > 0 && (
                    <View style={styles.historyDetails}>
                      
                      {/* Expense Summary */}
                      <View style={styles.historySectionBlock}>
                        <Text style={styles.historySectionTitle}>Expense Summary</Text>
                        <View style={styles.summaryRow}>
                          <Text style={styles.summaryLabel}>Subtotal</Text>
                          <Text style={styles.summaryValue}>${(h.subtotal || 0).toFixed(2)}</Text>
                        </View>
                        <View style={styles.summaryRow}>
                          <Text style={styles.summaryLabel}>Tax/Fees</Text>
                          <Text style={styles.summaryValue}>+ ${(h.tax || 0).toFixed(2)}</Text>
                        </View>
                        {!!h.discount && (
                          <View style={styles.summaryRow}>
                            <Text style={styles.summaryLabel}>Discount</Text>
                            <Text style={styles.summaryValue}>- ${(h.discount || 0).toFixed(2)}</Text>
                          </View>
                        )}
                        <View style={[styles.summaryRow, { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#333' }]}>
                          <Text style={[styles.summaryLabel, { fontWeight: 'bold', color: '#fff' }]}>Total</Text>
                          <Text style={[styles.summaryValue, { fontWeight: 'bold', color: '#ff8a00' }]}>${(h.total || 0).toFixed(2)}</Text>
                        </View>
                      </View>

                      {/* Who Owes What? */}
                      {h.peopleSubtotals && Object.keys(h.peopleSubtotals).length > 0 && (
                        <View style={styles.historySectionBlock}>
                          <Text style={styles.historySectionTitle}>Who Owes What?</Text>
                          {Object.entries(h.peopleSubtotals).map(([person, amount]: [string, any], idx) => (
                            <View key={idx} style={styles.summaryRow}>
                              <Text style={styles.summaryLabel}>👤 {person}</Text>
                              <Text style={styles.summaryValue}>${(amount || 0).toFixed(2)}</Text>
                            </View>
                          ))}
                        </View>
                      )}

                      {/* Items List */}
                      <View style={styles.historySectionBlock}>
                        <Text style={styles.historySectionTitle}>Item List</Text>
                        {h.items.map((item: any, idx: number) => (
                          <View key={idx} style={styles.historyItemRow}>
                            <View style={styles.historyItemMain}>
                              <Text style={styles.historyItemName}>{item.Item}</Text>
                              <Text style={styles.historyItemAssignee}>👤 {item.BelongsTo}</Text>
                            </View>
                            <Text style={styles.historyItemPrice}>${(item.Price || 0).toFixed(2)}</Text>
                          </View>
                        ))}
                      </View>

                    </View>
                  )}
                </TouchableOpacity>
              ))}
              {state.history.length > 5 && (
                <TouchableOpacity style={{marginTop: 10, alignItems: 'center'}} onPress={() => setShowAllHistory(!showAllHistory)}>
                  <Text style={{color: '#ff8a00'}}>{showAllHistory ? 'Show Less' : 'Show More'}</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
        
        <View style={styles.footerLinks}>
          <TouchableOpacity onPress={() => Linking.openURL('https://www.websaleem.com/shopshare/privacy.html')}>
            <Text style={styles.footerLinkText}>🔒 Privacy Policy</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => Linking.openURL('https://www.websaleem.com/shopshare/terms.html')}>
            <Text style={styles.footerLinkText}>📄 Terms of Service</Text>
          </TouchableOpacity>
        </View>

        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', alignItems: 'center' },
  container: { flex: 1, backgroundColor: '#000', width: '100%', maxWidth: 600 },
  header: {
    paddingTop: Platform.OS === 'web' ? 20 : 60,
    paddingHorizontal: 20,
    paddingBottom: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.25)',
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16
  },
  logo: {
    width: 48,
    height: 48,
    borderRadius: 12
  },
  settingsBtn: {
    padding: 8,
    backgroundColor: '#2a2a2a',
    borderRadius: 20
  },
  settingsIcon: { fontSize: 24 },
  title: { color: '#ff8a00', fontSize: 28, fontWeight: 'bold' },
  subtitle: { color: '#aaa', fontSize: 16, marginTop: 4 },
  content: { flex: 1, padding: 20 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    justifyContent: 'space-between',
    marginBottom: 40
  },
  card: {
    width: '47%',
    backgroundColor: '#1a1a1a',
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333'
  },
  cardIcon: { fontSize: 32, marginBottom: 12 },
  cardTitle: { color: '#fff', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  loadingContainer: { alignItems: 'center', marginVertical: 20 },
  loadingText: { color: '#ff8a00', marginTop: 10 },
  historySection: { marginBottom: 60 },
  sectionTitle: { color: '#fff', fontSize: 20, fontWeight: 'bold', marginBottom: 16 },
  emptyText: { color: 'rgba(255,255,255,0.5)', fontStyle: 'italic', fontSize: 14 },
  footerLinks: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
    marginTop: 30,
    marginBottom: 40,
  },
  footerLinkText: {
    color: '#ff8a00',
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  historyCard: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    marginBottom: 8,
    overflow: 'hidden'
  },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
  },
  historyName: { color: '#fff', flex: 1, marginRight: 12, fontWeight: '600' },
  historyDate: { color: '#888' },
  historyDetails: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: '#333',
    paddingTop: 12
  },
  historySectionBlock: {
    marginBottom: 16
  },
  historySectionTitle: {
    color: '#aaa',
    fontSize: 12,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    marginBottom: 8,
    letterSpacing: 1
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4
  },
  summaryLabel: { color: '#ccc', fontSize: 14 },
  summaryValue: { color: '#fff', fontSize: 14, fontWeight: '500' },
  historyItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8
  },
  historyItemMain: {
    flex: 1,
    marginRight: 10
  },
  historyItemName: {
    color: '#ccc',
    fontSize: 14
  },
  historyItemAssignee: {
    color: '#ff8a00',
    fontSize: 12,
    marginTop: 2
  },
  historyItemPrice: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500'
  }
});
