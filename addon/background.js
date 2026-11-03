// The manager is the add-on's options page (open_in_tab), so Thunderbird reuses an already open tab.
browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

// "Sieve-Regel aus dieser Mail": button in the message view and context menu in the message list.
function openRuleWindow(messageId) {
  return browser.windows.create({
    url: `rule/rule.html?message=${encodeURIComponent(messageId)}`,
    type: 'popup',
    width: 760,
    height: 860,
  });
}

browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  const message = await browser.messageDisplay.getDisplayedMessage(tab.id);
  if (message) await openRuleWindow(message.id);
});

browser.menus.create({
  id: 'sieve-rule-from-mail',
  title: 'Sieve-Regel aus dieser Mail …',
  contexts: ['message_list'],
});

browser.menus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'sieve-rule-from-mail') return;
  const message = info.selectedMessages?.messages?.[0];
  if (message) await openRuleWindow(message.id);
});
