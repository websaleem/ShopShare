import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, Alert, Platform } from 'react-native';
import { useAppState } from '../context/StateContext';
import { useRouter } from 'expo-router';

export default function SettingsScreen() {
  const { state, updateState, signOut, clearState } = useAppState();
  const router = useRouter();

  const [newPersonName, setNewPersonName] = useState('');
  const [newPersonEmail, setNewPersonEmail] = useState('');
  
  // Local state for editing drafts
  const [edits, setEdits] = useState<Record<string, {name: string, email: string}>>({});

  const handleDeleteAccount = () => {
    Alert.alert(
      "Delete Account",
      "WARNING: This will permanently delete your account, your profile, and all your saved data. This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Delete", 
          style: "destructive", 
          onPress: async () => {
            if (!state.token) return;
            try {
              const API_BASE = "https://your-api-id.execute-api.your-region.amazonaws.com/shopshare/api";
              const res = await fetch(`${API_BASE}/account`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${state.token}` }
              });
              if (!res.ok) console.warn("Failed to delete backend state");

              const { getCurrentUser } = require('../services/auth');
              const cognitoUser = getCurrentUser();
              if (cognitoUser) {
                cognitoUser.getSession((err: any, session: any) => {
                  if (err) {
                    Alert.alert("Error", err.message);
                    return;
                  }
                  cognitoUser.deleteUser((delErr: any, result: any) => {
                    if (delErr) {
                      Alert.alert("Error deleting account", delErr.message);
                      return;
                    }
                    Alert.alert("Account Deleted", "Your account has been permanently deleted.");
                    clearState();
                    signOut();
                  });
                });
              } else {
                clearState();
                signOut();
              }
            } catch (e) {
              Alert.alert("Network error", (e as Error).message);
            }
          }
        }
      ]
    );
  };

  const handleSignOut = () => {
    signOut();
    router.replace('/auth');
  };

  const addPerson = () => {
    const trimmedName = newPersonName.trim();
    const trimmedEmail = newPersonEmail.trim();
    if (!trimmedName || !trimmedEmail || state.people.includes(trimmedName)) return;

    if (!/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
      Alert.alert("Invalid Email", "Please enter a valid email address.");
      return;
    }

    const newEmails = { ...(state.peopleEmails || {}) };
    newEmails[trimmedName] = trimmedEmail;

    updateState({ 
      people: [...state.people, trimmedName],
      peopleEmails: newEmails
    });
    setNewPersonName('');
    setNewPersonEmail('');
  };

  const removePerson = (person: string) => {
    Alert.alert("Remove Person", `Are you sure you want to remove ${person}? Their assigned items will become Unassigned.`, [
      { text: "Cancel", style: "cancel" },
      { 
        text: "Remove", 
        style: "destructive",
        onPress: () => {
          const newItems = state.items.map(i => i.BelongsTo === person ? { ...i, BelongsTo: 'Unassigned' } : i);
          const newPending = state.pending.map(i => i.BelongsTo === person ? { ...i, BelongsTo: 'Unassigned' } : i);
          
          const newEmails = { ...(state.peopleEmails || {}) };
          delete newEmails[person];

          updateState({
            people: state.people.filter(p => p !== person),
            items: newItems,
            pending: newPending,
            peopleEmails: newEmails
          });
        }
      }
    ]);
  };

  const savePerson = (oldName: string) => {
    const edit = edits[oldName];
    if (!edit) return;
    const newName = edit.name.trim();
    const newEmail = edit.email.trim();

    if (!newName) {
      Alert.alert("Invalid Name", "Name cannot be empty.");
      return;
    }

    if (newEmail && !/^\S+@\S+\.\S+$/.test(newEmail)) {
      Alert.alert("Invalid Email", "Please enter a valid email address.");
      return;
    }

    if (newName !== oldName && state.people.includes(newName)) {
      Alert.alert("Duplicate Name", "This person already exists.");
      return;
    }

    const newPeople = state.people.map(p => p === oldName ? newName : p);
    const newItems = state.items.map(i => i.BelongsTo === oldName ? { ...i, BelongsTo: newName } : i);
    const newPending = state.pending.map(i => i.BelongsTo === oldName ? { ...i, BelongsTo: newName } : i);
    
    const newEmails = { ...(state.peopleEmails || {}) };
    if (oldName !== newName) {
      delete newEmails[oldName];
    }
    newEmails[newName] = newEmail;

    const updates: any = { 
      people: newPeople, 
      items: newItems, 
      pending: newPending,
      peopleEmails: newEmails
    };
    if (state.people[0] === oldName) {
      updates.fullName = newName;
    }
    
    updateState(updates);

    setEdits(prev => {
      const copy = { ...prev };
      delete copy[oldName];
      return copy;
    });
  };

  const mainUser = state.people[0] || state.fullName || 'User';
  const otherPeople = state.people.slice(1);

  return (
    <View style={styles.root}>
      <View style={styles.container}>
        <Text style={styles.title}>Settings</Text>

      <ScrollView style={styles.scroll}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Your Name</Text>
          <View style={styles.personRow}>
            <View style={{flex: 1}}>
              <TextInput
                style={[styles.personInput, {paddingBottom: 4}]}
                value={edits[mainUser] ? edits[mainUser].name : mainUser}
                onChangeText={(txt) => setEdits(prev => ({...prev, [mainUser]: { name: txt, email: prev[mainUser]?.email ?? (state.peopleEmails?.[mainUser] || '') }}))}
                placeholder="Your Name"
                placeholderTextColor="#999"
              />
              <TextInput
                style={[styles.personInput, {paddingTop: 0, paddingBottom: 12, fontSize: 14, color: '#aaa'}]}
                value={edits[mainUser] !== undefined ? edits[mainUser].email : (state.peopleEmails?.[mainUser] || '')}
                onChangeText={(txt) => setEdits(prev => ({...prev, [mainUser]: { name: prev[mainUser]?.name ?? mainUser, email: txt }}))}
                placeholder="Your Email"
                placeholderTextColor="#666"
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>
            {(edits[mainUser] && (edits[mainUser].name !== mainUser || edits[mainUser].email !== (state.peopleEmails?.[mainUser] || ''))) && (
              <TouchableOpacity style={styles.saveBtn} onPress={() => savePerson(mainUser)}>
                <Text style={styles.saveBtnText}>Save</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Other Persons</Text>
          {otherPeople.map(person => (
            <View key={person} style={styles.personRow}>
              <View style={{flex: 1}}>
                <TextInput
                  style={[styles.personInput, {paddingBottom: 4}]}
                  value={edits[person] ? edits[person].name : person}
                  onChangeText={(txt) => setEdits(prev => ({...prev, [person]: { name: txt, email: prev[person]?.email ?? (state.peopleEmails?.[person] || '') }}))}
                  placeholder="Person Name"
                  placeholderTextColor="#999"
                />
                <TextInput
                  style={[styles.personInput, {paddingTop: 0, paddingBottom: 12, fontSize: 14, color: '#aaa'}]}
                  value={edits[person] !== undefined ? edits[person].email : (state.peopleEmails?.[person] || '')}
                  onChangeText={(txt) => setEdits(prev => ({...prev, [person]: { name: prev[person]?.name ?? person, email: txt }}))}
                  placeholder="Person Email"
                  placeholderTextColor="#666"
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>
              {(edits[person] && (edits[person].name !== person || edits[person].email !== (state.peopleEmails?.[person] || ''))) && (
                <TouchableOpacity style={styles.saveBtn} onPress={() => savePerson(person)}>
                  <Text style={styles.saveBtnText}>Save</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.removeBtn} onPress={() => removePerson(person)}>
                <Text style={styles.removeText}>✕</Text>
              </TouchableOpacity>
            </View>
          ))}

          <View style={[styles.addRow, { flexDirection: 'column' }]}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                style={styles.addInput}
                placeholder="Name..."
                placeholderTextColor="#999"
                value={newPersonName}
                onChangeText={setNewPersonName}
              />
              <TextInput
                style={styles.addInput}
                placeholder="Email..."
                placeholderTextColor="#999"
                value={newPersonEmail}
                onChangeText={setNewPersonEmail}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>
            <TouchableOpacity style={[styles.addBtn, { paddingVertical: 12, marginTop: 8 }]} onPress={addPerson}>
              <Text style={styles.addBtnText}>Add Person</Text>
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.deleteAccountBtn} onPress={handleDeleteAccount}>
          <Text style={styles.signOutText}>Delete Account</Text>
        </TouchableOpacity>

      </ScrollView>

        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>Close Settings</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#1a1a1a', alignItems: 'center' },
  container: { flex: 1, backgroundColor: '#1a1a1a', paddingTop: Platform.OS === 'web' ? 20 : 60, width: '100%', maxWidth: 600 },
  scroll: { flex: 1, paddingHorizontal: 24 },
  title: { color: '#fff', fontSize: 28, fontWeight: 'bold', marginBottom: 30, paddingHorizontal: 24 },
  section: {
    backgroundColor: '#2a2a2a',
    padding: 16,
    borderRadius: 8,
    marginBottom: 30
  },
  sectionTitle: { color: '#ff8a00', fontSize: 16, fontWeight: 'bold', marginBottom: 16 },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#3a3a3a',
    borderRadius: 8,
    marginBottom: 12,
    paddingRight: 8
  },
  personInput: {
    flex: 1,
    color: '#fff',
    fontSize: 16,
    padding: 16,
  },
  saveBtn: {
    backgroundColor: '#ff8a00',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginRight: 8,
    justifyContent: 'center',
    alignItems: 'center'
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14
  },
  removeBtn: { padding: 8 },
  removeText: { color: '#ff4444', fontSize: 20, fontWeight: 'bold' },
  addRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8
  },
  addInput: {
    flex: 1,
    backgroundColor: '#3a3a3a',
    color: '#fff',
    fontSize: 16,
    padding: 16,
    borderRadius: 8
  },
  addBtn: {
    backgroundColor: '#ff8a00',
    justifyContent: 'center',
    paddingHorizontal: 20,
    borderRadius: 8
  },
  addBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  signOutBtn: {
    backgroundColor: 'rgba(255, 68, 68, 0.1)',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 68, 68, 0.3)'
  },
  deleteAccountBtn: {
    backgroundColor: 'rgba(255, 68, 68, 0.1)',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 40,
    borderWidth: 1,
    borderColor: 'rgba(255, 68, 68, 0.3)'
  },
  signOutText: { color: '#ff4444', fontSize: 16, fontWeight: 'bold' },
  backBtn: {
    padding: 16,
    paddingBottom: 40,
    alignItems: 'center',
    backgroundColor: '#2a2a2a'
  },
  backText: { color: '#fff', fontSize: 16, fontWeight: 'bold' }
});
