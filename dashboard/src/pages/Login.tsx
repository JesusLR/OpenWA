import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { GithubIcon } from '../components/GithubIcon';
import { API_BASE_URL } from '../services/api';
import './Login.css';

interface LoginProps {
  onLogin: (apiKey: string, role?: string, engineType?: string, scoped?: boolean) => void;
}

export function Login({ onLogin }: LoginProps) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // The stored key is matched against key prefixes elsewhere, so a pasted space must not reach it.
    const key = apiKey.trim();
    if (!key) {
      setError(t('login.apiKeyRequired'));
      return;
    }
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE_URL}/auth/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': key,
        },
      });

      if (response.ok) {
        // The validate body already carries the key's role — hand it up so the app can set it
        // directly instead of re-validating the same key a second time.
        const data: { role?: string; engineType?: string; scoped?: unknown } = await response.json().catch(() => ({}));
        onLogin(
          key,
          data.role,
          typeof data.engineType === 'string' ? data.engineType : undefined,
          data.scoped === true,
        );
      } else {
        // A 5xx, or a body that is not the gateway's JSON (a proxy error page while it restarts), says
        // nothing about the key; a refusal keeps the gateway's reason (expired, revoked, rate limited).
        const errorData: { message?: unknown } = await response.json().catch(() => ({}));
        const reason = response.status < 500 && typeof errorData.message === 'string' ? errorData.message : '';
        setError(reason || t(response.status === 401 ? 'login.invalidKey' : 'login.connectionError'));
      }
    } catch {
      setError(t('login.connectionError'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo login-hero">
          <img src="/logo_pds.png" alt="OpenWA" className="logo-icon" />
          <p className="logo-tagline">Servicio de mensajeria OpenWA.</p>
          <span className="version-info">
            {t('login.version', {
              version: __APP_VERSION__,
              // ISO date (YYYYMMDD) so the format is stable across locales/regions instead of the
              // locale-dependent toLocaleDateString() which renders differently per browser region.
              date: new Date(__BUILD_TIME__).toISOString().slice(0, 10).replace(/-/g, ''),
            })}
          </span>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="input-group">
            <label htmlFor="apiKey">{t('login.apiKey')}</label>
            <div className="input-wrapper">
              <input
                id="apiKey"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={t('login.apiKeyPlaceholder')}
                className={error ? 'error' : ''}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'login-error' : undefined}
              />
              <button
                type="button"
                className="toggle-visibility"
                onClick={() => setShowKey(!showKey)}
                aria-label={showKey ? t('common.hideApiKey') : t('common.showApiKey')}
              >
                {showKey ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            {error && (
              <span id="login-error" className="error-message" role="alert">
                {error}
              </span>
            )}
          </div>

          <button type="submit" className="connect-btn" disabled={isLoading}>
            {isLoading ? t('login.connecting') : t('login.connect')}
          </button>
        </form>

        <p className="login-help">
          {t('login.help')}{' '}
          <a href="https://docs.open-wa.org" target="_blank" rel="noopener noreferrer">
            {t('login.viewDocs')}
          </a>
        </p>
      </div>

      <footer className="login-footer">
        <span>{t('login.footer')}</span>
        <a
          href="https://github.com/rmyndharis/OpenWA"
          target="_blank"
          rel="noopener noreferrer"
          className="github-link"
          aria-label="GitHub"
        >
          <GithubIcon size={18} />
        </a>
      </footer>
    </div>
  );
}
