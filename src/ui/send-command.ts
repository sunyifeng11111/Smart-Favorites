import { browser } from 'wxt/browser';

import type {
  CommandData,
  ExtensionCommand,
  ExtensionResponse,
} from '../runtime/messages';

export async function sendCommand(command: ExtensionCommand): Promise<CommandData> {
  const response = (await browser.runtime.sendMessage(command)) as ExtensionResponse;
  if (!response.ok) throw new Error(response.errorKey);
  return response.data;
}
