// The manager is the add-on's options page (open_in_tab), so Thunderbird reuses an already open tab.
browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

// Proton's captcha page (and the frames it nests) forbid being framed by other origins
// (X-Frame-Options / CSP frame-ancestors). Proton's own web client embeds it as an iframe, so we allow
// Proton frames only while this add-on's manager is their ancestor. The captcha is still solved by the user.
const MANAGER_ORIGIN = new URL(browser.runtime.getURL('')).origin;

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    const framedByUs = (details.frameAncestors ?? []).some((a) => a.url?.startsWith(MANAGER_ORIGIN))
      || details.documentUrl?.startsWith(MANAGER_ORIGIN)
      || details.originUrl?.startsWith(MANAGER_ORIGIN);
    if (!framedByUs) return {};

    const responseHeaders = details.responseHeaders
      .filter((h) => h.name.toLowerCase() !== 'x-frame-options')
      .map((h) => {
        if (h.name.toLowerCase() !== 'content-security-policy') return h;
        const value = h.value
          .split(';')
          .filter((d) => !d.trim().toLowerCase().startsWith('frame-ancestors'))
          .join(';');
        return { ...h, value };
      });
    return { responseHeaders };
  },
  {
    urls: ['https://*.proton.me/*'],
    types: ['sub_frame'],
  },
  ['blocking', 'responseHeaders'],
);
