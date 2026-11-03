const MANAGER_URL = browser.runtime.getURL('manager/manager.html');

browser.browserAction.onClicked.addListener(async () => {
  const [existing] = await browser.tabs.query({ url: MANAGER_URL });
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: MANAGER_URL });
  }
});
