import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';

import type { OperationState } from '../../src/application/types';
import { COPY, type CopyMessageKey } from '../../src/ui/copy';
import { sendCommand } from '../../src/ui/send-command';

export function PopupApp() {
  const [operation, setOperation] = useState<OperationState>();
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = COPY.productName;
    void runCommand({ type: 'START_SMART_SAVE' });
  }, []);

  async function runCommand(command: Parameters<typeof sendCommand>[0]) {
    setError('');
    try {
      const data = await sendCommand(command);
      if ('status' in data) {
        setOperation(data);
        if (!selectedFolderId && data.folders[0]) setSelectedFolderId(data.folders[0].id);
      }
    } catch (caught) {
      const key = caught instanceof Error ? caught.message : 'genericError';
      setError(key in COPY ? String(COPY[key as keyof typeof COPY]) : COPY.genericError);
    }
  }

  function confirm(folderId: string) {
    if (!operation) return;
    void runCommand({ type: 'CONFIRM_FOLDER', operationId: operation.id, folderId });
  }

  const stateMessage = operation?.messageKey
    ? COPY[operation.messageKey as CopyMessageKey]
    : operation?.page.classificationAllowed === false
      ? COPY.unsupportedPage
      : '';

  return (
    <main className="popup-shell">
      <header>
        <div className="brand-mark">S</div>
        <div>
          <h1>{COPY.productName}</h1>
          {operation?.page.title && <p className="page-title">{operation.page.title}</p>}
        </div>
      </header>

      {!operation && !error && <p className="status-card">{COPY.loading}</p>}
      {error && <p className="notice error">{error}</p>}

      {operation?.status === 'classifying' && <p className="status-card">{COPY.classifying}</p>}

      {operation?.status === 'consent-required' && (
        <section className="panel">
          <h2>{COPY.consentTitle}</h2>
          <p>{COPY.consentIntro}</p>
          <ul>{COPY.consentItems.map((item) => <li key={item}>{item}</li>)}</ul>
          <div className="actions">
            <button
              className="primary"
              onClick={() => void runCommand({ type: 'DECIDE_CONSENT', operationId: operation.id, granted: true })}
            >
              {COPY.consentAccept}
            </button>
            <button
              onClick={() => void runCommand({ type: 'DECIDE_CONSENT', operationId: operation.id, granted: false })}
            >
              {COPY.consentDecline}
            </button>
          </div>
        </section>
      )}

      {operation?.status === 'candidates' && (
        <section className="panel">
          <h2>{COPY.candidatesTitle}</h2>
          <div className="candidate-list">
            {operation.candidates.map((candidate) => (
              <button className="candidate" key={candidate.id} onClick={() => confirm(candidate.id)}>
                <span>{candidate.path}</span>
                <strong>{Math.round(candidate.probability * 100)}%</strong>
              </button>
            ))}
          </div>
        </section>
      )}

      {(operation?.status === 'manual-selection' || operation?.status === 'candidates') && (
        <section className="panel folder-panel">
          <h2>{COPY.allFoldersTitle}</h2>
          {stateMessage && <p className="notice">{stateMessage}</p>}
          {operation.folders.length > 0 && (
            <>
              <label htmlFor="folder">{COPY.chooseFolder}</label>
              <select id="folder" value={selectedFolderId} onChange={(event) => setSelectedFolderId(event.target.value)}>
                {operation.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
              </select>
              <button className="primary" disabled={!selectedFolderId} onClick={() => confirm(selectedFolderId)}>
                {COPY.saveHere}
              </button>
            </>
          )}
        </section>
      )}

      {operation?.status === 'saved' && (
        <section className="panel saved">
          <div className="success-mark">✓</div>
          <h2>{COPY.savedTitle}</h2>
          <p>{COPY.savedPathPrefix}{operation.finalFolderPath}</p>
        </section>
      )}

      <footer>
        <button className="link-button" onClick={() => void browser.runtime.openOptionsPage()}>{COPY.openSettings}</button>
      </footer>
    </main>
  );
}
