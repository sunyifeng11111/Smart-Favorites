import { useEffect, useState } from 'react';

import type { SettingsView } from '../../src/runtime/messages';
import { COPY } from '../../src/ui/copy';
import { sendCommand } from '../../src/ui/send-command';

export function OptionsApp() {
  const [settings, setSettings] = useState<SettingsView>();
  const [apiKey, setApiKey] = useState('');
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    document.title = `${COPY.productName} · ${COPY.settings}`;
    void refresh();
  }, []);

  async function refresh() {
    const data = await sendCommand({ type: 'GET_SETTINGS' });
    if ('hasApiKey' in data) setSettings(data);
  }

  async function saveKey() {
    try {
      const data = await sendCommand({ type: 'SAVE_API_KEY', apiKey });
      if ('hasApiKey' in data) setSettings(data);
      setApiKey('');
      setFeedback(COPY.keySaved);
    } catch (error) {
      setFeedback(messageFor(error));
    }
  }

  async function testKey() {
    try {
      await sendCommand({ type: 'TEST_API_KEY', ...(apiKey ? { apiKey } : {}) });
      setFeedback(COPY.keyValid);
    } catch (error) {
      setFeedback(messageFor(error));
    }
  }

  async function clearKey() {
    const data = await sendCommand({ type: 'CLEAR_API_KEY' });
    if ('hasApiKey' in data) setSettings(data);
    setApiKey('');
    setFeedback(COPY.keyCleared);
  }

  async function setConsent(granted: boolean) {
    const data = await sendCommand({ type: 'SET_CONSENT', granted });
    if ('hasApiKey' in data) setSettings(data);
  }

  return (
    <main className="settings-shell">
      <header>
        <div className="brand-mark">S</div>
        <div><h1>{COPY.productName}</h1><p>{COPY.settingsTitle}</p></div>
      </header>

      <section className="card">
        <h2>{COPY.keyLabel}</h2>
        <p className="warning">{COPY.unencryptedWarning}</p>
        <p>{settings?.hasApiKey ? `${COPY.keyStored}${settings.maskedApiKey}` : COPY.keyMissing}</p>
        <input
          type="password"
          value={apiKey}
          autoComplete="off"
          placeholder={COPY.keyPlaceholder}
          aria-label={COPY.keyLabel}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <div className="button-row">
          <button className="primary" onClick={() => void saveKey()}>{COPY.saveKey}</button>
          <button disabled={settings?.consent !== 'granted'} onClick={() => void testKey()}>{COPY.testKey}</button>
          <button className="danger" disabled={!settings?.hasApiKey} onClick={() => void clearKey()}>{COPY.clearKey}</button>
        </div>
        {feedback && <p className="feedback" role="status">{feedback}</p>}
      </section>

      <section className="card">
        <h2>{COPY.consentSetting}</h2>
        <p>{COPY.consentIntro}</p>
        <ul>{COPY.consentItems.map((item) => <li key={item}>{item}</li>)}</ul>
        <p>{settings?.consent === 'granted' ? COPY.consentGranted : settings?.consent === 'declined' ? COPY.consentDeclined : COPY.consentUnknown}</p>
        <div className="button-row">
          <button className="primary" onClick={() => void setConsent(true)}>{COPY.allowConsent}</button>
          <button onClick={() => void setConsent(false)}>{COPY.declineConsent}</button>
        </div>
      </section>
    </main>
  );
}

function messageFor(error: unknown): string {
  if (!(error instanceof Error)) return COPY.genericError;
  if (error.message === 'emptyKey') return COPY.emptyKey;
  if (error.message === 'keyInvalid') return COPY.keyInvalid;
  if (error.message === 'consentRequiredForTest') return COPY.consentRequiredForTest;
  return COPY.genericError;
}
