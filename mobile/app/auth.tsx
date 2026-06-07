import 'react-native-get-random-values';
import React, { useState } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, Image } from 'react-native';
import { AuthenticationDetails, CognitoUser, CognitoUserAttribute } from 'amazon-cognito-identity-js';
import { userPool } from '../services/auth';
import { useAppState } from '../context/StateContext';

export default function AuthScreen() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const { updateState } = useAppState();

  const handleAuth = () => {
    if (!email || !password) {
      Alert.alert('Error', 'Please enter email and password');
      return;
    }
    setLoading(true);

    if (isLogin) {
      const authDetails = new AuthenticationDetails({ Username: email, Password: password });
      const cognitoUser = new CognitoUser({ Username: email, Pool: userPool });

      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (result) => {
          setLoading(false);
          const token = result.getAccessToken().getJwtToken();
          // We will set the token immediately to speed up login.
          // The fullName can be fetched asynchronously in the background.
          updateState({ token });
          
          cognitoUser.getUserAttributes((err, attributes) => {
            if (!err) {
              const nameAttr = attributes?.find(a => a.getName() === 'name');
              if (nameAttr) updateState({ fullName: nameAttr.getValue() });
            }
          });
        },
        onFailure: (err) => {
          setLoading(false);
          Alert.alert('Login Failed', err.message || JSON.stringify(err));
        },
      });
    } else {
      if (!name) {
        setLoading(false);
        Alert.alert('Error', 'Please enter your full name');
        return;
      }
      
      const attributeList = [
        new CognitoUserAttribute({ Name: 'name', Value: name })
      ];

      userPool.signUp(email, password, attributeList, [], (err, result) => {
        setLoading(false);
        if (err) {
          if ((err as any).code === 'UsernameExistsException') {
            Alert.alert('Account Exists', 'Account already created. Please log in.');
          } else {
            Alert.alert('Sign Up Failed', err.message || JSON.stringify(err));
          }
          return;
        }
        Alert.alert('Success', 'Account created! Check your email for verification link or code if enabled. Please log in.');
        setIsLogin(true);
      });
    }
  };

  return (
    <KeyboardAvoidingView 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.root}
    >
     <View style={styles.container}>
      <View style={styles.brandContainer}>
        <Image source={require('../assets/shopshare_icon.png')} style={styles.logo} />
        <Text style={styles.brandTitle}>ShopShare</Text>
      </View>
      
      <View style={styles.card}>
        <Text style={styles.title}>{isLogin ? 'Welcome Back' : 'Create Account'}</Text>
        
        {!isLogin && (
          <TextInput
            style={styles.input}
            placeholder="Full Name"
            placeholderTextColor="#999"
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
          />
        )}

        <TextInput
          style={styles.input}
          placeholder="Email address"
          placeholderTextColor="#999"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#999"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        <TouchableOpacity style={styles.button} onPress={handleAuth} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{isLogin ? 'Sign In' : 'Sign Up'}</Text>}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setIsLogin(!isLogin)} style={styles.switchBtn}>
          <Text style={styles.switchText}>
            {isLogin ? "Don't have an account? Sign Up" : "Already have an account? Sign In"}
          </Text>
        </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  container: {
    width: '100%',
    maxWidth: 600,
    justifyContent: 'center',
    padding: 24,
  },
  brandContainer: {
    alignItems: 'center',
    marginBottom: 40,
  },
  logo: {
    width: 80,
    height: 80,
    borderRadius: 20,
    marginBottom: 16,
  },
  brandTitle: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#ff8a00',
  },
  card: {
    backgroundColor: '#2a2a2a',
    padding: 24,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 5,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 24,
    textAlign: 'center',
  },
  input: {
    backgroundColor: '#3a3a3a',
    color: '#fff',
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#ff8a00',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  switchBtn: {
    marginTop: 24,
    alignItems: 'center',
  },
  switchText: {
    color: '#ff8a00',
    fontSize: 14,
  }
});
