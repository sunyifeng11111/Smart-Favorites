import { useEffect, useState } from 'react';

import {
  buildRecentRecordsExport,
} from '../../src/application/recent-records';
import type { FolderExclusionNode } from '../../src/application/types';
import type { SettingsView } from '../../src/runtime/messages';
import { COPY } from '../../src/ui/copy';
import { sendCommand } from '../../src/ui/send-command';

export function OptionsApp() {
  const [settings, setSettings] = useState<SettingsView>();
  const [apiKey, setApiKey] = useState('');
  const [feedback, setFeedback] = useState('');
  const [exportAcknowledged, setExportAcknowledged] = useState(false);

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

  async function setFolderExcluded(folderId: string, excluded: boolean) {
    try {
      const data = await sendCommand({
        type: 'SET_FOLDER_EXCLUSION',
        folderId,
        excluded,
      });
      if ('hasApiKey' in data) setSettings(data);
    } catch (error) {
      setFeedback(messageFor(error));
    }
  }

  async function deleteRecentRecord(recordId: string) {
    const data = await sendCommand({ type: 'DELETE_RECENT_RECORD', recordId });
    if ('hasApiKey' in data) setSettings(data);
  }

  async function clearRecentRecords() {
    const data = await sendCommand({ type: 'CLEAR_RECENT_RECORDS' });
    if ('hasApiKey' in data) setSettings(data);
  }

  function exportRecentRecords() {
    if (!settings) return;
    try {
      const json = buildRecentRecordsExport(
        settings.recentRecords,
        exportAcknowledged,
        new Date().toISOString(),
      );
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `smart-favorites-recent-records-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setFeedback(COPY.recordsExported);
    } catch {
      setFeedback(COPY.exportAcknowledgementRequired);
    }
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

      <section className="card">
        <h2>{COPY.folderExclusionsTitle}</h2>
        <p>{COPY.folderExclusionsIntro}</p>
        {settings && settings.folderTree.length > 0 ? (
          <FolderTree
            nodes={settings.folderTree}
            onChange={(folderId, excluded) => void setFolderExcluded(folderId, excluded)}
          />
        ) : (
          <p>{COPY.folderTreeEmpty}</p>
        )}
      </section>

      <section className="card" id="recent-records">
        <div className="section-heading">
          <div>
            <h2>{COPY.recentRecordsTitle}</h2>
            <p>{COPY.recentRecordsIntro}</p>
          </div>
          <button
            className="danger"
            disabled={!settings?.recentRecords.length}
            onClick={() => void clearRecentRecords()}
          >
            {COPY.clearAllRecords}
          </button>
        </div>

        {settings && settings.recentRecords.length > 0 ? (
          <ol className="record-list">
            {settings.recentRecords.map((record) => (
              <li key={record.id} className="record-card">
                <div className="record-heading">
                  <div>
                    <strong>{record.title}</strong>
                    <a href={record.url} target="_blank" rel="noreferrer">{record.url}</a>
                  </div>
                  <button
                    className="danger compact"
                    aria-label={`${COPY.deleteRecord}：${record.title}`}
                    onClick={() => void deleteRecentRecord(record.id)}
                  >
                    {COPY.deleteRecord}
                  </button>
                </div>
                <dl className="record-details">
                  <dt>{COPY.recordTimestamp}</dt>
                  <dd>{new Date(record.timestamp).toLocaleString()}</dd>
                  {record.originalFolder && (
                    <><dt>{COPY.recordOriginalFolder}</dt><dd>{record.originalFolder.path}</dd></>
                  )}
                  <dt>{COPY.recordFinalFolder}</dt>
                  <dd>{record.finalFolder?.path ?? COPY.recordNoFinalFolder}</dd>
                  {record.preservedFolders && record.preservedFolders.length > 1 && (
                    <>
                      <dt>{COPY.recordPreservedFolders}</dt>
                      <dd>{record.preservedFolders.map(({ path }) => path).join('；')}</dd>
                    </>
                  )}
                  <dt>{COPY.recordUndoState}</dt>
                  <dd>{COPY.recordUndoStates[record.undoState]}</dd>
                  <dt>{COPY.recordClassificationPath}</dt>
                  <dd>{record.classificationPath.map(({ kind }) => COPY.recordEventLabels[kind]).join(' → ')}</dd>
                </dl>
              </li>
            ))}
          </ol>
        ) : (
          <p>{COPY.recentRecordsEmpty}</p>
        )}

        <div className="export-box">
          <label>
            <input
              type="checkbox"
              checked={exportAcknowledged}
              onChange={(event) => setExportAcknowledged(event.target.checked)}
            />
            <span>{COPY.exportWarning}</span>
          </label>
          <button
            disabled={!settings?.recentRecords.length || !exportAcknowledged}
            onClick={exportRecentRecords}
          >
            {COPY.exportRecords}
          </button>
        </div>
      </section>
    </main>
  );
}

function FolderTree({
  nodes,
  onChange,
}: {
  nodes: FolderExclusionNode[];
  onChange: (folderId: string, excluded: boolean) => void;
}) {
  return (
    <ul className="folder-tree">
      {nodes.map((node) => (
        <li key={node.id}>
          <label>
            <input
              type="checkbox"
              checked={!node.excluded}
              disabled={node.excludedByAncestor}
              onChange={(event) => onChange(node.id, !event.target.checked)}
            />
            <span className="folder-path">{node.path}</span>
            <span className="descendant-count">
              {COPY.folderDescendantCount(node.descendantCount)}
            </span>
          </label>
          {node.children.length > 0 && <FolderTree nodes={node.children} onChange={onChange} />}
        </li>
      ))}
    </ul>
  );
}

function messageFor(error: unknown): string {
  if (!(error instanceof Error)) return COPY.genericError;
  if (error.message === 'emptyKey') return COPY.emptyKey;
  if (error.message === 'keyInvalid') return COPY.keyInvalid;
  if (error.message === 'consentRequiredForTest') return COPY.consentRequiredForTest;
  return COPY.genericError;
}
