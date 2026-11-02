// Safari may serialize its UUID host with a different case for a worker sender.
// URL.origin is "null" for extension schemes, so compare the components explicitly.
export function sameExtensionOrigin(address: string | undefined, root: string) {
  if (!address) return false;
  try {
    const url = new URL(address);
    const expected = new URL(root);
    if (
      !['chrome-extension:', 'safari-web-extension:'].includes(expected.protocol) ||
      url.protocol !== expected.protocol ||
      !expected.hostname ||
      url.username ||
      url.password ||
      url.port ||
      expected.username ||
      expected.password ||
      expected.port
    )
      return false;
    return expected.protocol === 'safari-web-extension:'
      ? url.hostname.toLowerCase() === expected.hostname.toLowerCase()
      : url.hostname === expected.hostname;
  } catch {
    return false;
  }
}
