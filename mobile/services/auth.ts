import 'react-native-get-random-values';
import { CognitoUserPool, AuthenticationDetails, CognitoUser, CognitoUserAttribute } from 'amazon-cognito-identity-js';

// Fix #1: No hardcoded Cognito credentials — env vars are required
const userPoolId = process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID;
const clientId = process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID;

if (!userPoolId || !clientId) {
  throw new Error(
    'Cognito configuration missing. Set EXPO_PUBLIC_COGNITO_USER_POOL_ID and EXPO_PUBLIC_COGNITO_CLIENT_ID in your .env file.'
  );
}

const poolData = {
  UserPoolId: userPoolId,
  ClientId: clientId,
};

export const userPool = new CognitoUserPool(poolData);

export function getCurrentUser() {
  return userPool.getCurrentUser();
}

export function getSession(cognitoUser: CognitoUser): Promise<string> {
  return new Promise((resolve, reject) => {
    cognitoUser.getSession((err: any, session: any) => {
      if (err) {
        reject(err);
      } else {
        resolve(session.getAccessToken().getJwtToken());
      }
    });
  });
}

export function fetchUserAttributes(cognitoUser: CognitoUser): Promise<{ fullName: string }> {
  return new Promise((resolve, reject) => {
    cognitoUser.getUserAttributes((err, attributes) => {
      if (err) {
        reject(err);
        return;
      }
      const nameAttr = attributes?.find(a => a.getName() === 'name');
      resolve({ fullName: nameAttr ? nameAttr.getValue() : "Me" });
    });
  });
}

export function signOut(cognitoUser: CognitoUser) {
  cognitoUser.signOut();
}
