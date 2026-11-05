import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, test, vi } from 'vitest';

import enAuth from '@/modules/i18n/locales/en/auth.json';

/**
 * A second factor appears only when the server asks for it: the first submit
 * sends username + password; on `totpRequired` the form shows the code field
 * and the next submit carries the code.
 */
const login = vi.fn();
vi.mock('@/modules/auth/context/AuthContext', () => ({
  useAuth: () => ({ error: null, login }),
}));

const { default: LoginForm } = await import('@/modules/auth/LoginForm');

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { auth: enAuth } },
    ns: ['auth'],
    interpolation: { escapeValue: false },
  });
});

afterEach(() => {
  cleanup();
  login.mockReset();
});

test('the code field appears only when the server asks, and the code is sent', async () => {
  login
    .mockResolvedValueOnce({ success: false, error: '', totpRequired: true })
    .mockResolvedValueOnce({ success: true });
  render(<LoginForm />);
  assert.equal(document.getElementById('totp'), null);

  fireEvent.change(document.getElementById('username') as HTMLInputElement, { target: { value: 'alice' } });
  fireEvent.change(document.getElementById('password') as HTMLInputElement, { target: { value: 'pw' } });
  fireEvent.submit(document.querySelector('form') as HTMLFormElement);
  await waitFor(() => assert.ok(document.getElementById('totp')));
  assert.deepEqual(login.mock.calls[0], ['alice', 'pw', undefined]);

  fireEvent.change(document.getElementById('totp') as HTMLInputElement, { target: { value: '123456' } });
  fireEvent.submit(document.querySelector('form') as HTMLFormElement);
  await waitFor(() => assert.equal(login.mock.calls.length, 2));
  assert.deepEqual(login.mock.calls[1], ['alice', 'pw', '123456']);
  assert.ok(screen.getByText(enAuth.login.totp));
});
