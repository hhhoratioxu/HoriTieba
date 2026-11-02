// Safari uses the Promise response channel; Chrome 120 needs sendResponse + true.
// Never claim a message that this listener does not handle.
export function respondToMessage(result: Promise<unknown>, respond: (response: unknown) => void) {
  if (chrome.runtime.getURL('').startsWith('safari-web-extension://')) return result;
  void result.then(respond);
  return true;
}
