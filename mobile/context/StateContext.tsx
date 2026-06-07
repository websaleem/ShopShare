import React, { createContext, useContext, useState, useEffect } from 'react';
import { Alert, AppState as ReactNativeAppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { saveStateToCloud, loadStateFromCloud } from '../services/api';
import { userPool, getCurrentUser } from '../services/auth';

export interface ReceiptItem {
  Item: string;
  Price: number;
  BelongsTo: string;
}

export interface UploadHistory {
  key: string;
  filename: string;
  uploadedAt: number;
}

export interface ShopShareAppState {
  people: string[];
  peopleEmails: Record<string, string>;
  items: ReceiptItem[];
  pending: ReceiptItem[];
  uploads: UploadHistory[];
  history: any[];
  token: string | null;
  fullName: string | null;
  shopName?: string;
  purchaseDate?: string;
}

interface StateContextType {
  state: ShopShareAppState;
  setState: React.Dispatch<React.SetStateAction<ShopShareAppState>>;
  updateState: (updates: Partial<ShopShareAppState>) => void;
  clearState: () => void;
  signOut: () => void;
  refreshState: () => Promise<void>;
}

const StateContext = createContext<StateContextType | null>(null);

export function StateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ShopShareAppState>({
    people: ['Me'],
    peopleEmails: {},
    items: [],
    pending: [],
    uploads: [],
    history: [],
    token: null,
    fullName: null,
    shopName: "",
    purchaseDate: "",
  });

  // Guard: don't sync default state to cloud before we've loaded cloud data
  const cloudLoadedRef = React.useRef(false);

  // Load from Async Storage first for fast boot
  useEffect(() => {
    AsyncStorage.getItem('shopshare_native_state').then(saved => {
      if (saved) {
        try {
          setState(prev => ({ ...prev, ...JSON.parse(saved) }));
        } catch (e) {}
      }
    });
  }, []);

  const refreshState = async () => {
    if (!state.token) return;
    try {
      const cloudState = await loadStateFromCloud(state.token);
      if (cloudState && Object.keys(cloudState).length > 0) {
        setState(prev => {
          const next = { ...prev, ...cloudState };

          // Fresh session: clear transient data (items/pending/shopName).
          // People, history, settings persist across sessions.
          // Users must click "Save Bill" to move items into history before logging out.
          next.items = [];
          next.pending = [];
          next.uploads = [];
          next.shopName = "";
          next.purchaseDate = "";

          const persistentData = {
            people: next.people,
            peopleEmails: next.peopleEmails || {},
            items: [],
            pending: [],
            uploads: [],
            history: next.history || [],
            shopName: "",
          };
          AsyncStorage.setItem('shopshare_native_state', JSON.stringify(persistentData));
          // Sync cleared session state back to cloud
          if (next.token) {
            saveStateToCloud(persistentData, next.token).catch(err =>
              console.warn("Cloud sync error after clearing session", err)
            );
          }
          return next;
        });
      }
      cloudLoadedRef.current = true;
    } catch (err: any) {
      console.warn("Cloud load error", err);
      // Even on error, mark as loaded so the app remains usable
      cloudLoadedRef.current = true;
    }
  };

  // When token changes (i.e. user logged in), fetch cloud state
  useEffect(() => {
    if (state.token) {
      cloudLoadedRef.current = false; // reset on new login
      refreshState();
    }
  }, [state.token]);

  // Listen for AppState changes to refresh data when app comes to foreground
  useEffect(() => {
    const subscription = ReactNativeAppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'active' && state.token) {
        refreshState();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [state.token]);

  const updateState = (updates: Partial<ShopShareAppState>) => {
    setState(prev => {
      const next = { ...prev, ...updates };
      
      const persistentData = {
        people: next.people,
        peopleEmails: next.peopleEmails || {},
        items: next.items,
        pending: next.pending,
        uploads: next.uploads,
        history: next.history || [],
        shopName: next.shopName,
        purchaseDate: next.purchaseDate,
      };

      AsyncStorage.setItem('shopshare_native_state', JSON.stringify(persistentData));
      
      if (next.token && cloudLoadedRef.current) {
        // Only sync if actual data keys were changed AND cloud state has been loaded
        // This prevents the default state from overwriting cloud data on login
        const dataChanged = ('people' in updates) || ('items' in updates) || 
                            ('pending' in updates) || ('uploads' in updates) || 
                            ('shopName' in updates) || ('history' in updates) ||
                            ('purchaseDate' in updates) || ('peopleEmails' in updates);
                            
        if (dataChanged) {
          saveStateToCloud(persistentData, next.token).catch(err => {
            console.warn("Cloud sync error", err);
            Alert.alert("Cloud Sync Failed", err.message);
          });
        }
      }

      return next;
    });
  };

  const clearState = () => {
    const next: ShopShareAppState = {
      people: state.fullName ? [state.fullName] : ['Me'],
      peopleEmails: state.peopleEmails || {},
      items: [],
      pending: [],
      uploads: [],
      history: state.history || [],
      shopName: "",
      purchaseDate: "",
      token: state.token,
      fullName: state.fullName
    };
    setState(next);
    const persistentData = {
      people: next.people,
      peopleEmails: state.peopleEmails || {},
      items: [],
      pending: [],
      uploads: [],
      history: state.history || [],
      shopName: ""
    };
    AsyncStorage.setItem('shopshare_native_state', JSON.stringify(persistentData));
    if (state.token) {
      saveStateToCloud(persistentData, state.token).catch(err => console.warn("Cloud sync error", err));
    }
  };

  const signOut = () => {
    const user = getCurrentUser();
    if (user) {
      user.signOut();
    }
    const next: ShopShareAppState = {
      people: ['Me'],
      peopleEmails: {},
      items: [],
      pending: [],
      uploads: [],
      history: [],
      shopName: "",
      token: null,
      fullName: null
    };
    setState(next);
    AsyncStorage.removeItem('shopshare_native_state');
  };

  return (
    <StateContext.Provider value={{ state, setState, updateState, clearState, signOut, refreshState }}>
      {children}
    </StateContext.Provider>
  );
}

export function useAppState() {
  const ctx = useContext(StateContext);
  if (!ctx) throw new Error('useAppState must be used within StateProvider');
  return ctx;
}
