import assert from 'node:assert/strict';

import { act, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import enAuth from '@/modules/i18n/locales/en/auth.json';

/**
 * What a failed login puts on screen.
 *
 * `auth.routes` answers a rejected sign-in with the structured AppError
 * envelope — `{ success: false, error: { code, message } }` — while the older
 * shape is a bare string. `AuthContext` read `error` and handed it straight to
 * `setError`, so the login page rendered an object: React refuses that child
 * and the user saw no reason at all for the rejection.
 *
 * The fix that first addressed this was applied to a built bundle only, so the
 * next clean build dropped it silently. These cases pin the behaviour to the
 * source: the structured envelope and the legacy string envelope must both
 * arrive as the server's sentence, and an envelope with no sentence must fall
 * back to the translated generic rather than to an object.
 */

const LOGIN_FAILED_TEXT = 'Login failed';
const SERVER_SENTENCE = 'Invalid username or password';

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['auth'],
    defaultNS: 'auth',
    resources: { en: { auth: enAuth } },
    interpolation: { escapeValue: false },
  });
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const installFetch = (loginBody: unknown) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/api/auth/login')) {
      return jsonResponse(loginBody, 401);
    }

    if (url.includes('/api/auth/status')) {
      return jsonResponse({ needsSetup: false });
    }

    if (url.includes('/api/user/onboarding-status')) {
      return jsonResponse({ hasCompletedOnboarding: true });
    }

    return jsonResponse({});
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

let loginResult: Awaited<ReturnType<ReturnType<typeof useAuth>['login']>> | null = null;

function Probe() {
  const { error, login } = useAuth();
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void login('alice', 'wrong-password').then((result) => {
            loginResult = result;
          });
        }}
      >
        sign in
      </button>
      {/* Attribute, not text: the login page renders the same string and a
          second text node here would make the assertion ambiguous. */}
      <span data-testid="probe-error" data-error={error ?? ''} />
    </div>
  );
}

const submitLogin = async () => {
  loginResult = null;
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await act(async () => {
    screen.getByText('sign in').click();
  });

  const shown = screen.getByTestId('probe-error').getAttribute('data-error');
  return { shown, result: loginResult };
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a structured AppError envelope shows the sentence it carries', async () => {
  installFetch({
    success: false,
    error: { code: 'AUTH_INVALID_CREDENTIALS', message: SERVER_SENTENCE },
  });

  const { shown, result } = await submitLogin();

  assert.equal(shown, SERVER_SENTENCE, 'the login page must render the string, not an object');
  assert.equal(result?.error, SERVER_SENTENCE);
  assert.equal(result?.success, false);
});

test('the legacy string envelope still shows its sentence', async () => {
  installFetch({ error: SERVER_SENTENCE });

  const { shown } = await submitLogin();

  assert.equal(shown, SERVER_SENTENCE);
});

test('an envelope with no sentence falls back to the translated generic', async () => {
  installFetch({ success: false, error: { code: 'AUTH_INVALID_CREDENTIALS' } });

  const { shown } = await submitLogin();

  assert.equal(shown, LOGIN_FAILED_TEXT);
});
