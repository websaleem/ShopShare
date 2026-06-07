import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert, Platform, Modal } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Picker } from '@react-native-picker/picker';
import { useAppState, ReceiptItem } from '../context/StateContext';

export default function ReceiptScreen() {
  const { state, updateState, signOut, clearState } = useAppState();
  const router = useRouter();
  const [newItemName, setNewItemName] = useState('');
  const [newItemPrice, setNewItemPrice] = useState('');

  const [splitModalVisible, setSplitModalVisible] = useState(false);
  const [splitIndex, setSplitIndex] = useState(-1);
  const [splitIsPending, setSplitIsPending] = useState(false);
  const [splitTotalQty, setSplitTotalQty] = useState('2');
  const [splitAllocations, setSplitAllocations] = useState<Record<string, number>>({});
  
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const [sharingStatus, setSharingStatus] = useState('');



  // Calculation Logic
  const allItems = [...state.items, ...state.pending];
  
  // Basic Items vs Tax/Tip
  const standardItems = allItems.filter(i => 
    !i.Item.toLowerCase().includes("tax") && 
    !i.Item.toLowerCase().includes("tip") && 
    !i.Item.toLowerCase().includes("fee")
  );
  
  const surchargeItems = allItems.filter(i => 
    i.Item.toLowerCase().includes("tax") || 
    i.Item.toLowerCase().includes("tip") || 
    i.Item.toLowerCase().includes("fee")
  );

  const subtotal = standardItems.reduce((acc, val) => acc + val.Price, 0);
  const totalSurcharges = surchargeItems.reduce((acc, val) => acc + val.Price, 0);

  const getPersonTotal = (person: string) => {
    let personTotal = 0;
    standardItems.forEach(item => {
      if (item.BelongsTo === person) personTotal += item.Price;
      if (item.BelongsTo === "Everyone") personTotal += (item.Price / state.people.length);
    });

    // Proportional surcharges
    if (subtotal > 0 && personTotal > 0) {
      const share = personTotal / subtotal;
      personTotal += (totalSurcharges * share);
    }
    return personTotal;
  };

  const cyclePerson = (index: number, isPending: boolean) => {
    const list = isPending ? state.pending : state.items;
    const item = list[index];
    const currentIndex = state.people.indexOf(item.BelongsTo);
    
    let nextPerson = "";
    if (item.BelongsTo === "Unassigned") {
      nextPerson = "Everyone";
    } else if (item.BelongsTo === "Everyone") {
      nextPerson = state.people[0];
    } else {
      if (currentIndex === -1 || currentIndex === state.people.length - 1) {
        nextPerson = "Unassigned";
      } else {
        nextPerson = state.people[currentIndex + 1];
      }
    }

    const newList = [...list];
    newList[index] = { ...item, BelongsTo: nextPerson };

    if (isPending) updateState({ pending: newList });
    else updateState({ items: newList });
  };

  const deleteItem = (index: number, isPending: boolean) => {
    const list = isPending ? state.pending : state.items;
    const newList = list.filter((_, i) => i !== index);
    if (isPending) updateState({ pending: newList });
    else updateState({ items: newList });
  };

  const openSplitModal = (index: number, isPending: boolean) => {
    setSplitIndex(index);
    setSplitIsPending(isPending);
    setSplitTotalQty('2');
    const initialAllocations: Record<string, number> = {};
    ["Unassigned", ...state.people].forEach(p => initialAllocations[p] = 0);
    setSplitAllocations(initialAllocations);
    setSplitModalVisible(true);
  };

  const handleAllocationChange = (person: string, valStr: string) => {
    const val = parseInt(valStr, 10) || 0;
    const totalQty = parseInt(splitTotalQty, 10) || 0;
    
    let sumOthers = 0;
    state.people.forEach(p => {
      if (p !== person) sumOthers += splitAllocations[p] || 0;
    });
    
    const maxAllowed = totalQty - sumOthers;
    const safeVal = Math.min(Math.max(0, val), maxAllowed);
    
    setSplitAllocations(prev => ({
      ...prev,
      [person]: safeVal
    }));
  };

  const getUnassignedCount = () => {
    const totalQty = parseInt(splitTotalQty, 10) || 0;
    let sumAssigned = 0;
    state.people.forEach(p => sumAssigned += splitAllocations[p] || 0);
    return Math.max(0, totalQty - sumAssigned);
  };

  const saveSplit = () => {
    const totalQty = parseInt(splitTotalQty, 10) || 0;
    if (totalQty < 2) return;
    
    const list = splitIsPending ? state.pending : state.items;
    const item = list[splitIndex];
    if (!item) return;

    const baseName = item.Item || "Item";
    const basePrice = item.Price || 0;
    
    const newItems: ReceiptItem[] = [];
    const unassignedQty = getUnassignedCount();
    
    const peopleKeys = ["Unassigned", ...state.people];
    peopleKeys.forEach(p => {
      const qty = p === "Unassigned" ? unassignedQty : (splitAllocations[p] || 0);
      if (qty > 0) {
        const splitPrice = (qty / totalQty) * basePrice;
        newItems.push({
          Item: `${baseName} (${qty}/${totalQty})`,
          Price: splitPrice,
          BelongsTo: p
        });
      }
    });

    const newList = [...list];
    newList.splice(splitIndex, 1, ...newItems);
    
    if (splitIsPending) updateState({ pending: newList });
    else updateState({ items: newList });
    
    setSplitModalVisible(false);
  };

  const saveInvoice = () => {
    if (allItems.length === 0) {
      Alert.alert("Error", "No items to save.");
      return;
    }

    const subtotals: Record<string, number> = {};
    let finalTotal = 0;
    
    state.people.forEach(p => {
      const pTotal = getPersonTotal(p);
      subtotals[p] = pTotal;
      finalTotal += pTotal;
    });
    
    let unassignedTotal = 0;
    standardItems.forEach(item => {
      if (item.BelongsTo === 'Unassigned') {
        unassignedTotal += item.Price;
      }
    });
    if (unassignedTotal > 0) {
      subtotals['Unassigned'] = unassignedTotal;
      finalTotal += unassignedTotal;
    }

    const historyEntry = {
      id: Date.now().toString(),
      date: state.purchaseDate || new Date().toISOString(),
      shopName: state.shopName || "Unknown Shop",
      items: JSON.parse(JSON.stringify(allItems)),
      subtotal: subtotal,
      tax: totalSurcharges,
      discount: 0,
      total: finalTotal,
      peopleSubtotals: subtotals
    };

    updateState({
      history: [historyEntry, ...(state.history || [])],
      items: allItems,
      pending: [],
      purchaseDate: ""
    });
    
    Alert.alert("Success", "Invoice saved to history!");
    router.push('/');
  };

  const addManualItem = () => {
    const price = parseFloat(newItemPrice);
    if (!newItemName.trim() || isNaN(price)) {
      alert("Please enter a valid name and price.");
      return;
    }
    const newItem = { Item: newItemName.trim(), Price: price, BelongsTo: 'Unassigned' };
    updateState({ items: [newItem, ...state.items] });
    setNewItemName('');
    setNewItemPrice('');
  };

  const renderItem = (item: ReceiptItem, index: number, isPending: boolean) => (
    <View key={index} style={styles.itemRow}>
      <View style={styles.itemInfo}>
        <Text style={styles.itemName}>{item.Item}</Text>
        <Text style={styles.itemPrice}>${item.Price.toFixed(2)}</Text>
      </View>
      <View style={styles.itemActions}>
        <TouchableOpacity style={styles.splitBtn} onPress={() => openSplitModal(index, isPending)}>
          <Text style={styles.splitTxt}>✂️</Text>
        </TouchableOpacity>
        <TouchableOpacity 
          style={[styles.badge, item.BelongsTo === 'Unassigned' ? styles.badgeUnassigned : styles.badgeAssigned]}
          onPress={() => cyclePerson(index, isPending)}
        >
          <Text style={styles.badgeText}>{item.BelongsTo}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.deleteBtn} onPress={() => deleteItem(index, isPending)}>
          <Text style={styles.deleteTxt}>✕</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerRight: () => <TouchableOpacity onPress={() => router.push('/people')} style={{marginRight: 15}}><Text style={{fontSize: 24}}>👥</Text></TouchableOpacity> }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.shopNameRow}>
          <Text style={styles.header}>Receipt from:</Text>
          <TextInput 
            style={styles.shopNameInput}
            placeholder="Shop name..."
            placeholderTextColor="#999"
            value={state.shopName || ""}
            onChangeText={(text) => updateState({ shopName: text })}
          />
        </View>
        
        <View style={styles.manualEntryRow}>
          <TextInput 
            style={styles.manualInputName} 
            placeholder="Item name..." 
            placeholderTextColor="#999"
            value={newItemName}
            onChangeText={setNewItemName}
          />
          <TextInput 
            style={styles.manualInputPrice} 
            placeholder="$0.00" 
            placeholderTextColor="#999"
            keyboardType="decimal-pad"
            value={newItemPrice}
            onChangeText={setNewItemPrice}
          />
          <TouchableOpacity style={styles.manualAddBtn} onPress={addManualItem}>
            <Text style={styles.manualAddBtnText}>Add</Text>
          </TouchableOpacity>
        </View>

        {state.items.map((item, i) => renderItem(item, i, false))}
        {state.pending.map((item, i) => renderItem(item, i, true))}

        {(state.pending.length > 0 || state.items.length > 0) && (
          <TouchableOpacity style={[styles.manualAddBtn, { marginVertical: 10, paddingVertical: 12 }]} onPress={saveInvoice}>
            <Text style={styles.manualAddBtnText}>Save Invoice</Text>
          </TouchableOpacity>
        )}

        {allItems.length === 0 && (
          <Text style={styles.emptyTxt}>No items yet. Take a picture of a receipt!</Text>
        )}

        <View style={styles.totalsCard}>
          <Text style={styles.totalsHeader}>Totals</Text>
          {state.people.map(person => (
            <View key={person} style={styles.totalRow}>
              <Text style={styles.totalName}>{person}</Text>
              <Text style={styles.totalAmt}>${getPersonTotal(person).toFixed(2)}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={styles.fabContainer}>
        <TouchableOpacity style={[styles.fab, { backgroundColor: '#ff8a00' }]} onPress={() => setShareModalVisible(true)}>
          <Text style={styles.fabIcon}>📤</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={splitModalVisible} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Split Item</Text>
            {splitIndex >= 0 && (
              <Text style={styles.modalSubtitle}>
                Splitting: {(splitIsPending ? state.pending : state.items)[splitIndex]?.Item}
              </Text>
            )}
            


            <ScrollView style={styles.allocationsList}>
              {["Unassigned", ...state.people].map(p => {
                const isUnassigned = p === "Unassigned";
                const currentVal = isUnassigned ? getUnassignedCount() : (splitAllocations[p] || 0);
                const maxOptions = currentVal + getUnassignedCount();
                
                return (
                  <View key={p} style={styles.allocationRow}>
                    <Text style={[styles.allocationName, isUnassigned && {color: '#888'}]}>{p}</Text>
                    {isUnassigned ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={{ color: '#888', fontSize: 16 }}>Left:</Text>
                        <TextInput
                          style={[styles.allocationInput, {backgroundColor: '#2a2a2a', color: '#888', width: 45, padding: 8}]}
                          keyboardType="number-pad"
                          value={currentVal.toString()}
                          editable={false}
                        />
                        <Text style={{ color: '#fff', fontSize: 16 }}>Total:</Text>
                        <TextInput
                          style={[styles.allocationInput, {backgroundColor: '#3a3a3a', color: '#fff', width: 50, padding: 8}]}
                          keyboardType="number-pad"
                          value={splitTotalQty}
                          onChangeText={(t) => {
                            setSplitTotalQty(t);
                            const tq = parseInt(t, 10) || 0;
                            let sum = 0;
                            state.people.forEach(person => sum += splitAllocations[person] || 0);
                            if (sum > tq) {
                              const r: Record<string, number> = {};
                              state.people.forEach(person => r[person] = 0);
                              setSplitAllocations(r);
                            }
                          }}
                        />
                      </View>
                    ) : (
                      <View style={styles.pickerContainer}>
                        <Picker
                          selectedValue={currentVal}
                          onValueChange={(val) => handleAllocationChange(p, val.toString())}
                          style={styles.picker}
                          dropdownIconColor="#fff"
                          mode="dropdown"
                          itemStyle={{ color: '#fff' }}
                        >
                          {Array.from({ length: maxOptions + 1 }, (_, i) => (
                            <Picker.Item key={i} label={i.toString()} value={i} />
                          ))}
                        </Picker>
                      </View>
                    )}
                  </View>
                );
              })}
            </ScrollView>

            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setSplitModalVisible(false)}>
                <Text style={styles.modalCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.modalSaveBtn, ((parseInt(splitTotalQty, 10)||0) < 2) && {opacity: 0.5}]} 
                onPress={saveSplit}
                disabled={(parseInt(splitTotalQty, 10)||0) < 2}
              >
                <Text style={styles.modalSaveTxt}>Save Split</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={shareModalVisible} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Share Bill</Text>
            <Text style={styles.modalSubtitle}>Select someone to share this bill with.</Text>

            <ScrollView style={styles.allocationsList}>
              {state.people.filter(p => p !== 'Me' && state.peopleEmails?.[p]).length === 0 ? (
                <Text style={{color: '#999'}}>No people with email addresses added. Go to People settings first.</Text>
              ) : (
                state.people.filter(p => p !== 'Me' && state.peopleEmails?.[p]).map(p => (
                  <TouchableOpacity 
                    key={p} 
                    style={[styles.allocationRow, { backgroundColor: '#3a3a3a', padding: 12, borderRadius: 8 }]}
                    onPress={async () => {
                      try {
                        setSharingStatus(`Sharing with ${p}...`);
                        const token = state.token; // we have it in state
                        if (!token) {
                          setSharingStatus('❌ Not logged in.');
                          return;
                        }
                        const API_BASE = "https://your-api-id.execute-api.your-region.amazonaws.com/shopshare/api";
                        const res = await fetch(`${API_BASE}/share`, {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                          },
                          body: JSON.stringify({
                            email: state.peopleEmails?.[p],
                            name: p,
                            shopName: state.shopName || "",
                            items: allItems
                          })
                        });
                        const data = await res.json();
                        if (res.ok) {
                          setSharingStatus(`✅ Shared with ${p}!`);
                          setTimeout(() => {
                            setShareModalVisible(false);
                            setSharingStatus('');
                          }, 2000);
                        } else {
                          setSharingStatus(`❌ ${data.error || 'Failed'}`);
                        }
                      } catch (e) {
                        setSharingStatus(`❌ Network error`);
                      }
                    }}
                  >
                    <View>
                      <Text style={styles.allocationName}>{p}</Text>
                      <Text style={{color: '#999', fontSize: 12}}>{state.peopleEmails?.[p]}</Text>
                    </View>
                    <Text style={{color: '#ff8a00'}}>Share</Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>

            {sharingStatus ? <Text style={{color: '#fff', textAlign: 'center', marginBottom: 16}}>{sharingStatus}</Text> : null}

            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => { setShareModalVisible(false); setSharingStatus(''); }}>
                <Text style={styles.modalCancelTxt}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a1a' },
  header: { fontSize: 24, fontWeight: 'bold', color: '#ff8a00' },
  shopNameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, gap: 10 },
  shopNameInput: { flex: 1, backgroundColor: '#1a1a1a', color: '#fff', fontSize: 18, fontWeight: '600', padding: 8, borderRadius: 8, borderWidth: 1, borderColor: '#333' },
  scroll: { padding: 20, paddingBottom: 100 },
  itemRow: {
    backgroundColor: '#2a2a2a',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  itemInfo: { flex: 1 },
  itemName: { color: '#fff', fontSize: 16, fontWeight: '500' },
  itemPrice: { color: '#ff8a00', fontSize: 14, marginTop: 4 },
  itemActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  badge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  badgeUnassigned: { backgroundColor: '#444' },
  badgeAssigned: { backgroundColor: 'rgba(255, 138, 0, 0.2)' },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  splitBtn: { padding: 4 },
  splitTxt: { fontSize: 16 },
  deleteBtn: { padding: 8 },
  deleteTxt: { color: '#ff4444', fontSize: 16, fontWeight: 'bold' },
  emptyTxt: { color: '#888', textAlign: 'center', marginTop: 40 },
  totalsCard: {
    backgroundColor: '#2a2a2a',
    borderRadius: 16,
    padding: 20,
    marginTop: 30
  },
  totalsHeader: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 16 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  totalName: { color: '#ccc', fontSize: 16 },
  totalAmt: { color: '#ff8a00', fontSize: 16, fontWeight: 'bold' },
  manualEntryRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20
  },
  manualInputName: {
    flex: 2,
    backgroundColor: '#3a3a3a',
    color: '#fff',
    borderRadius: 8,
    padding: 12,
  },
  manualInputPrice: {
    flex: 1,
    backgroundColor: '#3a3a3a',
    color: '#fff',
    borderRadius: 8,
    padding: 12,
  },
  manualAddBtn: {
    backgroundColor: '#ff8a00',
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'center'
  },
  manualAddBtnText: { color: '#fff', fontWeight: 'bold' },
  fabContainer: {
    position: 'absolute',
    bottom: 30,
    right: 20,
    gap: 16,
    alignItems: 'center'
  },
  fab: {
    backgroundColor: '#333',
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 5
  },
  fabIcon: { fontSize: 24 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    padding: 20
  },
  modalContent: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 24,
    maxHeight: '80%'
  },
  modalTitle: { color: '#ff8a00', fontSize: 22, fontWeight: 'bold' },
  modalSubtitle: { color: '#999', fontSize: 14, marginBottom: 20 },
  modalField: { marginBottom: 20 },
  modalLabel: { color: '#fff', fontSize: 14, marginBottom: 8 },
  modalInput: {
    backgroundColor: '#3a3a3a',
    color: '#fff',
    borderRadius: 8,
    padding: 12,
    fontSize: 16
  },
  allocationsList: { flexGrow: 0, marginBottom: 20 },
  allocationRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10
  },
  allocationName: { color: '#fff', fontSize: 16 },
  allocationInput: {
    backgroundColor: '#3a3a3a',
    color: '#fff',
    borderRadius: 8,
    padding: 10,
    width: 60,
    textAlign: 'center',
    fontSize: 16
  },
  pickerContainer: {
    backgroundColor: '#3a3a3a',
    borderRadius: 8,
    width: 90,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  picker: {
    color: '#fff',
    backgroundColor: 'transparent',
  },
  modalButtons: { flexDirection: 'row', gap: 12 },
  modalCancelBtn: {
    flex: 1,
    backgroundColor: '#3a3a3a',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center'
  },
  modalCancelTxt: { color: '#fff', fontWeight: 'bold' },
  modalSaveBtn: {
    flex: 1,
    backgroundColor: '#ff8a00',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center'
  },
  modalSaveTxt: { color: '#fff', fontWeight: 'bold' }
});
