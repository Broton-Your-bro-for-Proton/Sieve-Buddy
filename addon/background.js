// The manager is the add-on's options page (open_in_tab), so Thunderbird reuses an already open tab.
browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

// "Sieve rule from this mail": button in the message view and context menu in the message list.
function openRuleWindow(messageId) {
  return browser.windows.create({
    url: `rule/rule.html?message=${encodeURIComponent(messageId)}`,
    type: 'popup',
    // wide enough for the code beside the form (rule.css switches at 1200px) when the screen allows it
    width: Math.min(1500, screen.availWidth),
    height: Math.min(900, screen.availHeight),
  });
}

browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  const message = await browser.messageDisplay.getDisplayedMessage(tab.id);
  if (message) await openRuleWindow(message.id);
});

// loaded dynamically because the background script is not a module
import('./lib/i18n.js').then(({ t }) =>
  browser.menus.create({
    id: 'sieve-rule-from-mail',
    title: t('Sieve rule from this mail …'),
    contexts: ['message_list'],
  }),
);

browser.menus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'sieve-rule-from-mail') return;
  const message = info.selectedMessages?.messages?.[0];
  if (message) await openRuleWindow(message.id);
});
