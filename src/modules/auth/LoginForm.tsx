import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2, Lock, User } from 'lucide-react';

import { OAUTH_CONSENT_SPA_PATH } from '@shared/oauthConsent';
import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthInputField from '@/modules/auth/AuthInputField';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';

type LoginFormState = {
  username: string;
  password: string;
  totp: string;
};

const initialState: LoginFormState = {
  username: '',
  password: '',
  totp: '',
};

/**
 * Login form component.
 * Rendered by the auth module's ProtectedRoute when no user session exists.
 * Handles credential input with browser autofill support (`autocomplete`
 * attributes) so that password managers can offer to fill saved credentials.
 */
export default function LoginForm() {
  const { t } = useTranslation('auth');
  const { error: sessionError, login } = useAuth();

  const [formState, setFormState] = useState<LoginFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Shown once the server says this account has a second factor on.
  const [needsTotp, setNeedsTotp] = useState(false);

  // A visitor who reached the OAuth consent route without a session is signing
  // in FOR that authorization: a neutral line says why, in place of the (false)
  // "session expired" banner a never-signed-in visitor used to get.
  const reachedFromConsent =
    typeof window !== 'undefined' && window.location.pathname.endsWith(OAUTH_CONSENT_SPA_PATH);

  const updateField = useCallback((field: keyof LoginFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      // Keep form validation local so each auth screen owns its own UI feedback.
      if (!formState.username.trim() || !formState.password) {
        setErrorMessage(t('login.errors.requiredFields'));
        return;
      }

      if (needsTotp && !formState.totp.trim()) {
        setErrorMessage(t('login.errors.totpRequired'));
        return;
      }

      setIsSubmitting(true);
      const result = await login(
        formState.username.trim(),
        formState.password,
        needsTotp ? formState.totp.trim() : undefined,
      );
      if (!result.success) {
        if (result.totpRequired) {
          setNeedsTotp(true);
        }
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [formState.password, formState.totp, formState.username, login, needsTotp, t],
  );

  return (
    <AuthScreenLayout
      title={t('login.title')}
      description={t('login.description')}
      footerText={t('login.footerText')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {reachedFromConsent && (
          <p
            data-testid="consent-login-hint"
            className="text-sm leading-relaxed text-muted-foreground"
          >
            {t('login.consentPrompt')}
          </p>
        )}
        <AuthInputField
          id="username"
          label={t('login.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('login.placeholders.username')}
          isDisabled={isSubmitting}
          autoComplete="username"
          icon={User}
        />

        <AuthInputField
          id="password"
          label={t('login.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('login.placeholders.password')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="current-password"
          icon={Lock}
        />

        {needsTotp && (
          <AuthInputField
            id="totp"
            label={t('login.totp')}
            value={formState.totp}
            onChange={(value) => updateField('totp', value)}
            placeholder={t('login.placeholders.totp')}
            isDisabled={isSubmitting}
            autoComplete="one-time-code"
            icon={KeyRound}
          />
        )}

        <AuthErrorAlert errorMessage={errorMessage || sessionError || ''} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('login.loading')}
            </>
          ) : (
            t('login.submit')
          )}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
