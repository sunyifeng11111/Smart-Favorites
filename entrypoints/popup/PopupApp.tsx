import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  ArrowCounterClockwise,
  ArrowRight,
  ArrowsClockwise,
  Check,
  CheckCircle,
  CaretDown,
  ClockCounterClockwise,
  FolderSimple,
  GearSix,
  Info,
  ShieldCheck,
  WarningCircle,
} from '@phosphor-icons/react';

import type { OperationState } from '../../src/application/types';
import { BrandMark } from '../../src/ui/BrandMark';
import { COPY } from '../../src/ui/copy';
import { sendCommand } from '../../src/ui/send-command';

export function PopupApp() {
  const [operation, setOperation] = useState<OperationState>();
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [error, setError] = useState('');
  const [isWorking, setIsWorking] = useState(false);

  useEffect(() => {
    document.title = COPY.productName;
    void runCommand({ type: 'START_SMART_SAVE' });
  }, []);

  async function runCommand(command: Parameters<typeof sendCommand>[0]) {
    setError('');
    setIsWorking(true);
    try {
      const data = await sendCommand(command);
      if ('status' in data) {
        setOperation(data);
        if (
          data.status === 'saved' &&
          data.finalFolderId &&
          data.folders.some(({ id }) => id === data.finalFolderId)
        ) {
          setSelectedFolderId(data.finalFolderId);
        } else if (!data.folders.some(({ id }) => id === selectedFolderId) && data.folders[0]) {
          setSelectedFolderId(data.folders[0].id);
        }
      }
    } catch (caught) {
      const key = caught instanceof Error ? caught.message : 'genericError';
      setError(key in COPY ? String(COPY[key as keyof typeof COPY]) : COPY.genericError);
    } finally {
      setIsWorking(false);
    }
  }

  function confirm(folderId: string) {
    if (!operation) return;
    void runCommand({ type: 'CONFIRM_FOLDER', operationId: operation.id, folderId });
  }

  function changeDestination() {
    if (!operation || !selectedFolderId) return;
    void runCommand({
      type: 'CHANGE_DESTINATION',
      operationId: operation.id,
      folderId: selectedFolderId,
    });
  }

  function undo() {
    if (!operation) return;
    void runCommand({ type: 'UNDO_SMART_SAVE', operationId: operation.id });
  }

  function openRecentRecords() {
    const url = browser.runtime.getURL('/options.html#recent-records');
    void browser.tabs.create({ url });
  }

  const stateMessage = operation?.messageKey
    ? COPY[operation.messageKey]
    : operation?.page.classificationAllowed === false
      ? COPY.unsupportedPage
      : '';

  return (
    <main className="popup-shell" aria-busy={isWorking}>
      <header className="app-header">
        <BrandMark size="small" />
        <div>
          <h1>{COPY.productName}</h1>
          {operation?.page.title && <p className="page-title">{operation.page.title}</p>}
        </div>
      </header>

      {!operation && !error && <p className="status-card">{COPY.loading}</p>}
      {error && <p className="notice error"><WarningCircle weight="fill" />{error}</p>}

      {operation?.status === 'classifying' && <p className="status-card">{COPY.classifying}</p>}

      {operation?.status === 'disabled' && (
        <p className="notice">{COPY.incognitoDisabled}</p>
      )}

      {operation?.status === 'capture-failed' && (
        <section className="panel">
          <p className="notice">{COPY.pageChangedBeforeCapture}</p>
          <button className="primary" onClick={() => void runCommand({ type: 'START_SMART_SAVE' })}>
            <ArrowsClockwise weight="bold" />{COPY.retryClassification}
          </button>
        </section>
      )}

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
              <ShieldCheck weight="bold" />{COPY.consentAccept}
            </button>
            <button
              onClick={() => void runCommand({ type: 'DECIDE_CONSENT', operationId: operation.id, granted: false })}
            >
              {COPY.consentDecline}
            </button>
          </div>
        </section>
      )}

      {operation?.status === 'duplicate-warning' && (
        <section className="panel duplicate-warning">
          <h2>{COPY.duplicateTitle}</h2>
          <p>{COPY.duplicateIntro}</p>
          <ul className="duplicate-list">
            {operation.duplicateBookmarks.map((duplicate) => (
              <li key={duplicate.bookmarkId}>
                <strong>{duplicate.folderPath}</strong>
                <span>{duplicate.title}</span>
                <button
                  onClick={() => void runCommand({
                    type: 'RESOLVE_DUPLICATE',
                    operationId: operation.id,
                    action: 'reclassify',
                    bookmarkId: duplicate.bookmarkId,
                  })}
                >
                  <ArrowRight />{COPY.reclassifyExisting}
                </button>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button
              className="primary"
              onClick={() => void runCommand({
                type: 'RESOLVE_DUPLICATE',
                operationId: operation.id,
                action: 'preserve',
              })}
            >
              <Check weight="bold" />{COPY.preserveExisting}
            </button>
            <button
              onClick={() => void runCommand({
                type: 'RESOLVE_DUPLICATE',
                operationId: operation.id,
                action: 'create-copy',
              })}
            >
              {COPY.createAnotherCopy}
            </button>
          </div>
        </section>
      )}

      {operation?.status === 'duplicate-preserved' && (
        <section className="panel saved">
          <div className="success-mark"><CheckCircle weight="fill" /></div>
          <h2>{COPY.duplicatePreservedTitle}</h2>
          <p>{COPY.duplicatePreservedBody}</p>
        </section>
      )}

      {operation?.status === 'candidates' && (
        <section className="panel">
          <h2>{COPY.candidatesTitle}</h2>
          <div className="candidate-list">
            {operation.candidates.map((candidate) => (
              <button className="candidate" key={candidate.id} onClick={() => confirm(candidate.id)}>
                <span><FolderSimple />{candidate.path}</span>
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
              <div className="select-field">
                <select id="folder" value={selectedFolderId} onChange={(event) => setSelectedFolderId(event.target.value)}>
                  {operation.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
                </select>
                <CaretDown weight="bold" aria-hidden="true" />
              </div>
              <button className="primary" disabled={!selectedFolderId} onClick={() => confirm(selectedFolderId)}>
                <FolderSimple weight="fill" />{operation.selectedExistingBookmarkId ? COPY.moveExistingHere : COPY.saveHere}
              </button>
            </>
          )}
        </section>
      )}

      {operation?.status === 'pending' && (
        <section className="panel folder-panel">
          <h2>{COPY.pendingSavedTitle}</h2>
          {stateMessage && <p className="notice">{stateMessage}</p>}
          {operation.recoveryAction === 'choose-folder-manually' && operation.folders.length > 0 && (
            <>
              <label htmlFor="pending-folder">{COPY.chooseFolder}</label>
              <div className="select-field">
                <select
                  id="pending-folder"
                  value={selectedFolderId}
                  onChange={(event) => setSelectedFolderId(event.target.value)}
                >
                  {operation.folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>{folder.path}</option>
                  ))}
                </select>
                <CaretDown weight="bold" aria-hidden="true" />
              </div>
              <button className="primary" disabled={!selectedFolderId} onClick={() => confirm(selectedFolderId)}>
                <FolderSimple weight="fill" />{COPY.saveHere}
              </button>
            </>
          )}
          {operation.recoveryAction === 'repair-api-key' && (
            <button onClick={() => void browser.runtime.openOptionsPage()}>{COPY.openSettings}</button>
          )}
          <button
            onClick={() => void runCommand({ type: 'RETRY_PENDING', operationId: operation.id })}
          >
            <ArrowsClockwise />{COPY.retryClassification}
          </button>
          <button
            className="danger"
            onClick={undo}
          >
            <ArrowCounterClockwise />{COPY.undo}
          </button>
        </section>
      )}

      {operation?.status === 'saved' && (
        <section className="panel saved">
          <div className="success-mark"><CheckCircle weight="fill" /></div>
          <h2>{operation.saveMethod === 'automatic' ? COPY.automaticSavedTitle : COPY.savedTitle}</h2>
          <p>{COPY.savedPathPrefix}{operation.finalFolderPath}</p>
          {stateMessage && <p className="notice">{stateMessage}</p>}
          <div className="saved-actions">
            <div className="select-field">
              <select
                aria-label={COPY.chooseFolder}
                value={selectedFolderId}
                onChange={(event) => setSelectedFolderId(event.target.value)}
              >
                {operation.folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>{folder.path}</option>
                ))}
              </select>
              <CaretDown weight="bold" aria-hidden="true" />
            </div>
            <button onClick={changeDestination}><FolderSimple />{COPY.changeDestination}</button>
            <button className="danger" onClick={undo}>
              <ArrowCounterClockwise />{COPY.undo}
            </button>
          </div>
        </section>
      )}

      {operation?.status === 'undone' && (
        <section className="panel saved">
          <div className="success-mark"><ArrowCounterClockwise weight="bold" /></div>
          <h2>{COPY.undoneTitle}</h2>
          <p>{COPY.undoneBody}</p>
        </section>
      )}

      {operation && (
        <details className="signals">
          <summary><Info />{COPY.signalTitle}</summary>
          <dl>
            <dt>{COPY.signalUrl}</dt><dd>{operation.page.url}</dd>
            <dt>{COPY.signalDomain}</dt><dd>{operation.page.domain || '未提供'}</dd>
            <dt>{COPY.signalDescription}</dt><dd>{operation.page.description || '未提供'}</dd>
            <dt>{COPY.signalHeading}</dt><dd>{operation.page.h1 || '未提供'}</dd>
            <dt>{COPY.signalText}</dt><dd>{operation.page.visibleText || '未提供'}</dd>
          </dl>
        </details>
      )}

      <footer>
        <button className="link-button" onClick={() => void browser.runtime.openOptionsPage()}><GearSix />{COPY.openSettings}</button>
        <button className="link-button" onClick={openRecentRecords}><ClockCounterClockwise />{COPY.openRecentRecords}</button>
      </footer>
    </main>
  );
}
