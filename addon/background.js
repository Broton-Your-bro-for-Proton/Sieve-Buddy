// The manager is the add-on's options page (open_in_tab), so Thunderbird reuses an already open tab.
browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

// Proton's captcha page forbids being framed by other origins (X-Frame-Options / CSP frame-ancestors).
// Proton's own web client embeds it as an iframe, so we allow exactly that page, and only when it is
// framed by this add-on's manager. The captcha itself is still solved by the user.
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
    urls: ['https://mail.proton.me/api/core/v4/captcha*', 'https://mail-api.proton.me/core/v4/captcha*'],
    types: ['sub_frame'],
  },
  ['blocking', 'responseHeaders'],
);
