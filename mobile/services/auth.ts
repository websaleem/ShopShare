import 'react-native-get-random-values';
import { CognitoUserPool, AuthenticationDetails, CognitoUser, CognitoUserAttribute } from 'amazon-cognito-identity-js';

const poolData = {
  UserPoolId: process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID || 'your-region_YourPoolId',
  ClientId: process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID || 'your-client-id'
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
