import 'react-native-get-random-values';
import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useState } from 'react';
import { StateProvider, useAppState } from '../context/StateContext';
import { getCurrentUser, getSession, fetchUserAttributes } from '../services/auth';

function RootLayoutNav() {
  const { state, updateState } = useAppState();
  const segments = useSegments();
  const router = useRouter();
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const user = getCurrentUser();
    if (user) {
      getSession(user).then(token => {
        fetchUserAttributes(user).then(({ fullName }) => {
          updateState({ 
            token, 
            fullName,
            people: state.people[0] === 'Me' ? [fullName, ...state.people.slice(1)] : state.people
          });
          setIsReady(true);
        }).catch(() => setIsReady(true));
      }).catch(() => {
        setIsReady(true);
      });
    } else {
      setIsReady(true);
    }
  }, []);

  useEffect(() => {
    if (!isReady) return;

    const inAuthGroup = segments[0] === 'auth';
    if (!state.token && !inAuthGroup) {
      router.replace('/auth');
    } else if (state.token && inAuthGroup) {
      router.replace('/');
    }
  }, [state.token, segments, isReady]);

  if (!isReady) return null;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#1a1a1a' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: 'bold' },
        contentStyle: { backgroundColor: '#1a1a1a' },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'ShopShare', headerShown: false }} />
      <Stack.Screen name="auth" options={{ headerShown: false }} />
      <Stack.Screen name="receipt" options={{ title: 'Receipt Items', presentation: 'modal' }} />
      <Stack.Screen name="people" options={{ title: 'Manage People', presentation: 'modal' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <StateProvider>
      <RootLayoutNav />
    </StateProvider>
  );
}
