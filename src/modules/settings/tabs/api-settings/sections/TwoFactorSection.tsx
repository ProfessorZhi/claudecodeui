import { useCallback, useEffect, useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '@/shared/api';
import { Button, Input } from '@/shared/ui';

type Status = { enabled: boolean; pending: boolean };
type Setup = { secret: string; otpauthUri: string };

async function call<T>(url: string, body?: unknown): Promise<{ ok: boolean; data: T | null; message: string }> {
  const response = await authenticatedFetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  const error = (data as { error?: { message?: string } } | null)?.error;
  return { ok: response.ok, data: response.ok ? (data as T) : null, message: error?.message ?? '' };
}

/**
 * Two-factor sign-in (TOTP) for the signed-in account. Rendered by
 * CredentialsSettingsTab. Setup shows a secret to add to an authenticator app;
 * nothing changes for sign-in until one code from that app is confirmed.
 * Turning it off asks for the password and a current code.
 */
export default function TwoFactorSection() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const result = await call<Status>('/api/auth/2fa/status');
    if (result.ok && result.data) setStatus(result.data);
  }, []);

  useEffect(() => {
    let alive = true;
    call<Status>('/api/auth/2fa/status').then((result) => {
      if (alive && result.ok && result.data) setStatus(result.data);
    }, () => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }, []);

  const start = () => run(async () => {
    const result = await call<Setup>('/api/auth/2fa/setup', {});
    if (result.ok && result.data) {
      setSetup(result.data);
      setCode('');
    } else {
      setMessage(result.message || t('twoFactor.failed'));
    }
  });

  const confirm = () => run(async () => {
    const result = await call<{ enabled: boolean }>('/api/auth/2fa/enable', { code: code.trim() });
    if (result.ok) {
      setSetup(null);
      setCode('');
      setMessage(t('twoFactor.enabledMessage'));
      await refresh();
    } else {
      setMessage(result.message || t('twoFactor.failed'));
    }
  });

  const turnOff = () => run(async () => {
    const result = await call<{ enabled: boolean }>('/api/auth/2fa/disable', {
      password,
      code: code.trim(),
    });
    if (result.ok) {
      setPassword('');
      setCode('');
      setMessage(t('twoFactor.disabledMessage'));
      await refresh();
    } else {
      setMessage(result.message || t('twoFactor.failed'));
    }
  });

  return (
    <div data-testid="two-factor-section">
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck className="h-5 w-5" />
        <h3 className="text-lg font-semibold">{t('twoFactor.title')}</h3>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{t('twoFactor.description')}</p>

      {status?.enabled ? (
        <div className="space-y-3">
          <p className="text-sm font-medium">{t('twoFactor.on')}</p>
          <Input
            type="password"
            autoComplete="current-password"
            placeholder={t('twoFactor.password')}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder={t('twoFactor.code')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button size="sm" variant="outline" disabled={busy || !password || !code} onClick={turnOff}>
            {t('twoFactor.turnOff')}
          </Button>
        </div>
      ) : setup ? (
        <div className="space-y-3">
          <p className="text-sm">{t('twoFactor.addToApp')}</p>
          <code className="block break-all rounded bg-muted p-2 text-sm" data-testid="two-factor-secret">
            {setup.secret}
          </code>
          <a className="block break-all text-xs text-primary underline" href={setup.otpauthUri}>
            {setup.otpauthUri}
          </a>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder={t('twoFactor.code')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button size="sm" disabled={busy || !code} onClick={confirm}>
            <KeyRound className="mr-1 h-4 w-4" />
            {t('twoFactor.confirm')}
          </Button>
        </div>
      ) : (
        <Button size="sm" disabled={busy || status === null} onClick={start}>
          {t('twoFactor.turnOn')}
        </Button>
      )}

      {message && <p className="mt-3 text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
