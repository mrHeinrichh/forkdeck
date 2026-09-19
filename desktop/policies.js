function isAppUrl(value, origin) {
  try {
    const url = new URL(value);
    return Boolean(origin) && url.protocol === "http:" && url.origin === origin && !url.username && !url.password;
  } catch { return false; }
}

function isAllowedImage(details) {
  try {
    const url = new URL(details.url);
    return details.resourceType === "image" && url.protocol === "https:" &&
      ["github.com", "avatars.githubusercontent.com"].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

function externalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function trustedFrame(event, window, origin) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame?.url, origin));
}

function canWriteClipboard(contents, permission, details, window, origin) {
  return permission === "clipboard-sanitized-write" && Boolean(window && !window.isDestroyed()) &&
    contents === window.webContents && details?.isMainFrame === true &&
    isAppUrl(details.requestingUrl, origin) && isAppUrl(contents.getURL(), origin);
}

function requestHeaders(details, origin, token) {
  if (!isAppUrl(details.url, origin) && !isAllowedImage(details)) return { cancel: true };
  const headers = { ...details.requestHeaders };
  // Also remove case variants before attaching the single private-session token.
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "x-forkdeck-token") delete headers[name];
  }
  if (isAppUrl(details.url, origin)) headers["X-ForkDeck-Token"] = token;
  return { requestHeaders: headers };
}

module.exports = { isAppUrl, isAllowedImage, externalUrl, trustedFrame, canWriteClipboard, requestHeaders };
