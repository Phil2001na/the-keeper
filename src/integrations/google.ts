import { google } from 'googleapis';
import { config } from '../config.js';

export function googleEnabled(): boolean {
  return Boolean(
    config.googleClientId && config.googleClientSecret && config.googleRefreshToken
  );
}

/** Shared OAuth2 client, pre-loaded with Philip's refresh token. */
export function getOAuth2Client() {
  const auth = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    'http://localhost:3000'
  );
  auth.setCredentials({ refresh_token: config.googleRefreshToken });
  return auth;
}
