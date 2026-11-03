// The manager is the add-on's options page (open_in_tab), so Thunderbird reuses an already open tab.
browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());
