import { useEffect, useState } from 'react';
import {
  ArrowSquareOut,
  Check,
  CheckCircle,
  ClockCounterClockwise,
  DownloadSimple,
  FolderSimple,
  Key,
  LinkSimple,
  PencilSimple,
  ShieldCheck,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';

import { buildRecentRecordsExport } from '../../src/application/recent-records';
import type { FolderExclusionNode } from '../../src/application/types';
import type { SettingsView } from '../../src/runtime/messages';
import { BrandMark } from '../../src/ui/BrandMark';
import { COPY } from '../../src/ui/copy';
import { sendCommand } from '../../src/ui/send-command';

export function OptionsApp() {
  const [settings, setSettings] = useState<SettingsView>();
  const [apiKey, setApiKey] = useState('');
  const [feedback, setFeedback] = useState('');
  const [exportAcknowledged, setExportAcknowledged] = useState(false);
  const [busyAction, setBusyAction] = useState<string>();
  const [isEditingKey, setIsEditingKey] = useState(false);

  useEffect(() => {
    document.title = `${COPY.productName} - ${COPY.settings}`;
    void refresh();
  }, []);

  async function refresh() {
    const data = await sendCommand({ type: 'GET_SETTINGS' });
    if ('hasApiKey' in data) setSettings(data);
  }

  async function saveKey() {
    setBusyAction('save-key');
    try {
      const data = await sendCommand({ type: 'SAVE_API_KEY', apiKey });
      if ('hasApiKey' in data) setSettings(data);
      setApiKey('');
      setIsEditingKey(false);
      setFeedback(COPY.keySaved);
    } catch (error) {
      setFeedback(messageFor(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function testKey() {
    setBusyAction('test-key');
    try {
      await sendCommand({ type: 'TEST_API_KEY' });
      setIsEditingKey(false);
      setFeedback(COPY.keyValid);
    } catch (error) {
      setApiKey('');
      setIsEditingKey(true);
      setFeedback(messageFor(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function clearKey() {
    setBusyAction('clear-key');
    try {
      const data = await sendCommand({ type: 'CLEAR_API_KEY' });
      if ('hasApiKey' in data) setSettings(data);
      setApiKey('');
      setIsEditingKey(false);
      setFeedback(COPY.keyCleared);
    } finally {
      setBusyAction(undefined);
    }
  }

  async function setConsent(granted: boolean) {
    setBusyAction('consent');
    try {
      const data = await sendCommand({ type: 'SET_CONSENT', granted });
      if ('hasApiKey' in data) setSettings(data);
      setFeedback('');
    } finally {
      setBusyAction(undefined);
    }
  }

  async function setFolderExcluded(folderId: string, excluded: boolean) {
    try {
      const data = await sendCommand({ type: 'SET_FOLDER_EXCLUSION', folderId, excluded });
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

  const consentGranted = settings?.consent === 'granted';
  const keyIsEditable = !settings?.hasApiKey || isEditingKey;
  const keyAvailable = Boolean(apiKey.trim() || settings?.hasApiKey);
  const errorMessages: string[] = [
    COPY.keyInvalid,
    COPY.emptyKey,
    COPY.consentRequiredForTest,
    COPY.genericError,
    COPY.exportAcknowledgementRequired,
  ];
  const feedbackIsError = errorMessages.includes(feedback);
  const connectionHint = feedbackIsError
    ? COPY.connectionFailed
    : !consentGranted
    ? COPY.connectionNeedsConsent
    : !keyAvailable
      ? COPY.connectionNeedsKey
      : feedback === COPY.keyValid
        ? COPY.connectionHealthy
        : COPY.connectionReady;

  return (
    <main className="settings-shell" aria-busy={!settings}>
      <header className="app-header">
        <div className="brand-lockup">
          <BrandMark />
          <div>
            <h1>{COPY.productName}</h1>
            <p>{COPY.settingsDescription}</p>
          </div>
        </div>
        <span className="header-label">{COPY.settings}</span>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label={COPY.settingsNavigation}>
          <a href="#connection"><LinkSimple />{COPY.connectionNavigation}</a>
          <a href="#folders"><FolderSimple />{COPY.foldersNavigation}</a>
          <a href="#recent-records"><ClockCounterClockwise />{COPY.recordsNavigation}</a>
        </nav>

        <div className="settings-content">
          <section className="settings-section connection-section" id="connection">
            <div className="section-title">
              <div>
                <h2>{COPY.connectionTitle}</h2>
                <p>{COPY.connectionIntro}</p>
              </div>
              <span className={`connection-status ${feedback === COPY.keyValid ? 'is-success' : ''} ${feedbackIsError ? 'is-error' : ''}`}>
                {feedback === COPY.keyValid
                  ? <CheckCircle weight="fill" />
                  : feedbackIsError
                    ? <WarningCircle weight="fill" />
                    : <LinkSimple />}
                {connectionHint}
              </span>
            </div>

            <div className={`setup-step ${consentGranted ? 'is-complete' : 'is-current'}`}>
              <span className="step-icon">
                {consentGranted ? <Check weight="bold" /> : <ShieldCheck />}
              </span>
              <div className="step-content">
                <div className="step-heading">
                  <div>
                    <h3>{COPY.consentStepTitle}</h3>
                    <p>{COPY.consentStepHint}</p>
                  </div>
                  <span className="step-state">
                    {consentGranted
                      ? COPY.consentGranted
                      : settings?.consent === 'declined'
                        ? COPY.consentDeclined
                        : COPY.consentUnknown}
                  </span>
                </div>
                <details className="data-details">
                  <summary>{COPY.consentIntro}</summary>
                  <ul>{COPY.consentItems.map((item) => <li key={item}>{item}</li>)}</ul>
                </details>
                <div className="button-row">
                  <button
                    className="primary"
                    disabled={busyAction === 'consent' || consentGranted}
                    onClick={() => void setConsent(true)}
                  >
                    <ShieldCheck weight="bold" />
                    {consentGranted ? COPY.consentActive : COPY.allowConsent}
                  </button>
                  {consentGranted && (
                    <button
                      className="quiet"
                      disabled={busyAction === 'consent'}
                      onClick={() => void setConsent(false)}
                    >
                      {COPY.declineConsent}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className={`setup-step ${consentGranted ? 'is-current' : 'is-locked'}`}>
              <span className="step-icon"><Key /></span>
              <div className="step-content">
                <div className="step-heading">
                  <div>
                    <h3>{COPY.apiKeyStepTitle}</h3>
                    <p>{COPY.apiKeyStepHint}</p>
                  </div>
                  <span className="step-state">
                    {isEditingKey
                      ? COPY.keyEditing
                      : settings?.hasApiKey
                        ? `${COPY.keyStored}${settings.maskedApiKey}`
                        : COPY.keyMissing}
                  </span>
                </div>
                <label className="field-label" htmlFor="api-key">{COPY.keyLabel}</label>
                <input
                  id="api-key"
                  className="api-key-input"
                  type={keyIsEditable ? 'password' : 'text'}
                  value={keyIsEditable ? apiKey : settings?.maskedApiKey ?? ''}
                  autoComplete="off"
                  placeholder={COPY.keyPlaceholder}
                  readOnly={!keyIsEditable}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <p className="field-help">
                  {keyIsEditable ? COPY.unencryptedWarning : COPY.keyLockedHint}
                </p>
                <div className="button-row connection-actions">
                  {keyIsEditable ? (
                    <>
                      <button
                        className="primary"
                        disabled={!apiKey.trim() || Boolean(busyAction)}
                        onClick={() => void saveKey()}
                      >
                        <Key weight="bold" />
                        {busyAction === 'save-key'
                          ? '正在保存'
                          : settings?.hasApiKey
                            ? COPY.saveNewKey
                            : COPY.saveKey}
                      </button>
                      {settings?.hasApiKey && (
                        <button
                          className="quiet"
                          disabled={Boolean(busyAction)}
                          onClick={() => {
                            setApiKey('');
                            setIsEditingKey(false);
                            setFeedback('');
                          }}
                        >
                          {COPY.cancelKeyEdit}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        className="primary"
                        disabled={!consentGranted || Boolean(busyAction)}
                        onClick={() => void testKey()}
                      >
                        <LinkSimple weight="bold" />
                        {busyAction === 'test-key' ? '正在测试' : COPY.testKey}
                      </button>
                      <button
                        className="secondary"
                        disabled={Boolean(busyAction)}
                        onClick={() => {
                          setApiKey('');
                          setIsEditingKey(true);
                          setFeedback('');
                        }}
                      >
                        <PencilSimple />{COPY.editKey}
                      </button>
                    </>
                  )}
                  {settings?.hasApiKey && !isEditingKey && (
                    <button
                      className="quiet danger"
                      disabled={Boolean(busyAction)}
                      onClick={() => void clearKey()}
                    >
                      <Trash />{COPY.clearKey}
                    </button>
                  )}
                </div>
                {(!consentGranted || !keyAvailable) && !feedbackIsError && (
                  <p className="prerequisite"><WarningCircle />{connectionHint}</p>
                )}
                {feedback && (
                  <p className={`feedback ${feedbackIsError ? 'is-error' : 'is-success'}`} role="status">
                    {feedbackIsError
                      ? <WarningCircle weight="fill" />
                      : <CheckCircle weight="fill" />}
                    {feedback}
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="settings-section" id="folders">
            <div className="section-title compact-title">
              <div>
                <h2>{COPY.folderExclusionsTitle}</h2>
                <p>{COPY.folderExclusionsIntro}</p>
              </div>
            </div>
            {settings && settings.folderTree.length > 0 ? (
              <FolderTree
                nodes={settings.folderTree}
                onChange={(folderId, excluded) => void setFolderExcluded(folderId, excluded)}
              />
            ) : (
              <p className="empty-state"><FolderSimple />{COPY.folderTreeEmpty}</p>
            )}
          </section>

          <section className="settings-section" id="recent-records">
            <div className="section-heading">
              <div>
                <h2>{COPY.recentRecordsTitle}</h2>
                <p>{COPY.recentRecordsIntro}</p>
              </div>
              <button
                className="secondary danger"
                disabled={!settings?.recentRecords.length}
                onClick={() => void clearRecentRecords()}
              >
                <Trash />{COPY.clearAllRecords}
              </button>
            </div>

            {settings && settings.recentRecords.length > 0 ? (
              <ol className="record-list">
                {settings.recentRecords.map((record) => (
                  <li key={record.id} className="record-card">
                    <div className="record-heading">
                      <div>
                        <strong>{record.title}</strong>
                        <a href={record.url} target="_blank" rel="noreferrer">
                          {record.url}<ArrowSquareOut />
                        </a>
                      </div>
                      <button
                        className="quiet danger compact"
                        aria-label={`${COPY.deleteRecord}：${record.title}`}
                        onClick={() => void deleteRecentRecord(record.id)}
                      >
                        <Trash />{COPY.deleteRecord}
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
              <p className="empty-state"><ClockCounterClockwise />{COPY.recentRecordsEmpty}</p>
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
                className="secondary"
                disabled={!settings?.recentRecords.length || !exportAcknowledged}
                onClick={exportRecentRecords}
              >
                <DownloadSimple />{COPY.exportRecords}
              </button>
            </div>
          </section>
        </div>
      </div>
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
            <FolderSimple weight={node.excluded ? 'regular' : 'fill'} />
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
