// Runs on Proton's captcha page (opened in its own window) and forwards the solved token to the manager.
// With ForceWebMessaging=1 the page posts {type: 'pm_captcha', token} to its parent, which is itself here.
window.addEventListener('message', (event) => {
  let data = event.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return;
    }
  }
  if (data?.type === 'pm_captcha' && typeof data.token === 'string') {
    browser.runtime.sendMessage({ type: 'pm_captcha', token: data.token });
  }
});
