// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import type { RuntimeConfig } from './types';

/**
 * Minimal OAuth 2.0 authorization-code + PKCE flow against the Cognito
 * Hosted UI. No SDK: the flow is three steps (redirect to /oauth2/authorize,
 * exchange the code at /oauth2/token, store tokens in sessionStorage).
 */

const TOKENS_KEY = 'dg-auth-tokens';
const VERIFIER_KEY = 'dg-pkce-verifier';

export interface Tokens {
  accessToken: string;
  idToken: string;
  expiresAt: number;
}

function base64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function loadTokens(): Tokens | null {
  try {
    const raw = sessionStorage.getItem(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

export function currentAccessToken(): string | null {
  const tokens = loadTokens();
  return tokens && tokens.expiresAt > Date.now() + 30_000 ? tokens.accessToken : null;
}

export async function redirectToLogin(cfg: RuntimeConfig): Promise<void> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64Url(raw.buffer);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const query = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    scope: 'openid email',
    redirect_uri: cfg.redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.assign(`${cfg.cognitoDomain}/oauth2/authorize?${query}`);
}

export function signOut(cfg: RuntimeConfig): void {
  sessionStorage.removeItem(TOKENS_KEY);
  const query = new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.redirectUri });
  window.location.assign(`${cfg.cognitoDomain}/logout?${query}`);
}

/**
 * Returns valid tokens, or null after starting a redirect to the Hosted UI.
 */
export async function ensureAuthenticated(cfg: RuntimeConfig): Promise<Tokens | null> {
  const stored = loadTokens();
  if (stored && stored.expiresAt > Date.now() + 60_000) return stored;

  const code = new URLSearchParams(window.location.search).get('code');
  if (code) {
    const verifier = sessionStorage.getItem(VERIFIER_KEY) ?? '';
    const response = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: cfg.clientId,
        code,
        redirect_uri: cfg.redirectUri,
        code_verifier: verifier,
      }),
    });
    if (response.ok) {
      const data = await response.json();
      const tokens: Tokens = {
        accessToken: data.access_token,
        idToken: data.id_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
      sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
      sessionStorage.removeItem(VERIFIER_KEY);
      window.history.replaceState({}, '', window.location.pathname);
      return tokens;
    }
  }

  await redirectToLogin(cfg);
  return null;
}
