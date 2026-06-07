import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView } from 'react-native';
import { useAppState } from '../context/StateContext';
import { useRouter } from 'expo-router';

export default function PeopleScreen() {
  const { state, updateState } = useAppState();
  const router = useRouter();
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');

  const addPerson = () => {
    const trimmed = newName.trim();
    if (!trimmed || state.people.includes(trimmed)) return;
    
    const emails = { ...(state.peopleEmails || {}) };
    if (newEmail.trim()) {
      emails[trimmed] = newEmail.trim();
    }
    
    updateState({ 
      people: [...state.people, trimmed],
      peopleEmails: emails
    });
    setNewName('');
    setNewEmail('');
  };

  const removePerson = (person: string) => {
    // Re-assign items belonging to this person to 'Unassigned'
    const newItems = state.items.map(i => i.BelongsTo === person ? { ...i, BelongsTo: 'Unassigned' } : i);
    const newPending = state.pending.map(i => i.BelongsTo === person ? { ...i, BelongsTo: 'Unassigned' } : i);
    
    const newEmails = { ...(state.peopleEmails || {}) };
    delete newEmails[person];
    
    updateState({
      people: state.people.filter(p => p !== person),
      peopleEmails: newEmails,
      items: newItems,
      pending: newPending
    });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Who is splitting?</Text>
      
      <View style={styles.inputRow}>
        <View style={styles.inputsContainer}>
          <TextInput
            style={styles.input}
            placeholder="Name"
            placeholderTextColor="#999"
            value={newName}
            onChangeText={setNewName}
          />
          <TextInput
            style={styles.input}
            placeholder="Email (required for sharing)"
            placeholderTextColor="#999"
            keyboardType="email-address"
            autoCapitalize="none"
            value={newEmail}
            onChangeText={setNewEmail}
            onSubmitEditing={addPerson}
          />
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={addPerson}>
          <Text style={styles.addBtnText}>Add</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.list}>
        {state.people.map((person, idx) => (
          <View key={person} style={styles.personRow}>
            <View style={{flexDirection: 'column'}}>
              <Text style={styles.personName}>{person}</Text>
              {state.peopleEmails && state.peopleEmails[person] && (
                <Text style={{color: '#999', fontSize: 12, marginTop: 4}}>{state.peopleEmails[person]}</Text>
              )}
            </View>
            {idx !== 0 && ( // Prevent removing the main user
              <TouchableOpacity style={styles.removeBtn} onPress={() => removePerson(person)}>
                <Text style={styles.removeText}>✕</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
      </ScrollView>

      <TouchableOpacity style={styles.doneBtn} onPress={() => router.back()}>
        <Text style={styles.doneBtnText}>Done</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a1a', padding: 24 },
  title: { color: '#fff', fontSize: 28, fontWeight: 'bold', marginBottom: 24 },
  inputRow: { flexDirection: 'row', gap: 12, marginBottom: 30 },
  inputsContainer: { flex: 1, gap: 8 },
  input: {
    backgroundColor: '#3a3a3a',
    color: '#fff',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  addBtn: {
    backgroundColor: '#ff8a00',
    borderRadius: 8,
    paddingHorizontal: 20,
    justifyContent: 'center',
  },
  addBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  list: { flex: 1 },
  personRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#2a2a2a',
    padding: 16,
    borderRadius: 8,
    marginBottom: 12,
  },
  personName: { color: '#fff', fontSize: 16 },
  removeBtn: { padding: 8 },
  removeText: { color: '#ff4444', fontSize: 18, fontWeight: 'bold' },
  doneBtn: {
    backgroundColor: '#ff8a00',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 20
  },
  doneBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' }
});
