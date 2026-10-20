'use strict';

const path = require('node:path');
const { dialog } = require('electron');

// This scenario calls the real app.quit(). It must only run in the dedicated
// synthetic desktop profile; the outer harness treats an early exit as failure.
module.exports = async ({ app, window, store, operations, folder, page, wait, check, fill }) => {
  const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  if (typeof folder !== 'string' || !path.isAbsolute(folder) ||
      !same(app.getPath('userData'), path.join(folder, 'data')) ||
      !same(store.dataDir, path.join(folder, 'data')) ||
      !process.argv.includes('--desktop-test') || !process.argv.includes('--background-lifecycle-test')) {
    throw new Error('Quit cancellation verification requires the isolated background desktop fixture profile.');
  }
  const target = new URL(store.settings().baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || store.settings().model !== 'desktop-test-model') {
    throw new Error('Quit cancellation verification requires the synthetic local model server.');
  }

  const originalDialog = dialog.showMessageBoxSync;
  const prompts = [];
  let beforeQuitCount = 0, preventedUnloadCount = 0, createdTaskId;
  const beforeQuit = () => { beforeQuitCount++; };
  const preventedUnload = () => { preventedUnloadCount++; };
  const nodeWait = async predicate => {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Real Electron quit did not reach the dirty-document cancellation path.');
  };
  const exitGuard = () => page(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  const discardForm = async () => {
    if (window.isDestroyed()) return;
    const hasForm = await page(() => !!document.querySelector('.schedule-form'));
    if (!hasForm) return;
    await page(() => document.querySelector('[aria-label="返回计划列表"]').click());
    const outcome = await wait(() => !document.querySelector('.schedule-form') ? 'closed' :
      document.querySelector('.schedule-form .schedule-confirm') ? 'confirm' : false);
    if (outcome === 'confirm') {
      await page(() => [...document.querySelectorAll('.schedule-form .schedule-confirm button')]
        .find(button => button.textContent === '放弃修改').click());
      await wait(() => !document.querySelector('.schedule-form'));
    }
  };

  try {
    if (window.isDestroyed()) throw new Error('The desktop window was already destroyed before quit cancellation verification.');
    window.show(); window.focus(); window.webContents.focus();
    if (!await page(() => !!document.querySelector('[data-testid="schedule-panel"]'))) {
      await page(() => document.querySelector('[data-testid="schedules-open"]').click());
    }
    await wait(() => !!document.querySelector('[data-testid="schedule-new"]'));
    await page(() => document.querySelector('[data-testid="schedule-new"]').click());
    await fill('schedule-name', '未保存的退出回归草稿');
    await fill('schedule-prompt', 'QUIT_DIRTY_DRAFT_ONLY This draft must survive an aborted quit.');
    await wait(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    check('Dirty schedule form installs its real beforeunload guard before the quit attempt', await exitGuard());

    // Programmatic DOM input is not Chromium sticky activation. Send trusted
    // keyboard input through webContents, then retain the exact fixture value.
    await page(() => document.querySelector('[data-testid="schedule-name"]').focus());
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
    await wait(() => navigator.userActivation?.hasBeenActive === true);
    await fill('schedule-name', '未保存的退出回归草稿');
    check('Offscreen renderer receives trusted activation for Chromium beforeunload enforcement',
      await page(() => navigator.userActivation?.hasBeenActive === true));

    operations.saveBackgroundSettings({ backgroundTasks: true, launchAtLogin: false });
    check('Quit cancellation starts with an actual native background tray',
      (await page(() => window.muse.bootstrap())).app.backgroundTrayActive === true);
    dialog.showMessageBoxSync = (_parent, options) => {
      prompts.push({ title: options?.title, buttons: options?.buttons });
      return 0; // Continue editing; the production handler must cancel quit.
    };
    app.on('before-quit', beforeQuit);
    window.webContents.on('will-prevent-unload', preventedUnload);

    // Do not emit lifecycle events or prevent quit from the fixture. Electron
    // and the production dirty-document handler own the entire decision.
    app.quit();
    await nodeWait(() => prompts.length > 0 && preventedUnloadCount > 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    check('Real app.quit reaches Electron will-prevent-unload and the native Continue editing dialog',
      beforeQuitCount === 1 && preventedUnloadCount === 1 && prompts.length === 1 &&
      prompts[0].buttons?.[0] === '继续编辑');
    check('Cancelling native quit preserves the window, tray and unsaved schedule draft',
      !window.isDestroyed() && (await page(() => window.muse.bootstrap())).app.backgroundTrayActive === true &&
      await page(() => document.querySelector('[data-testid="schedule-name"]')?.value === '未保存的退出回归草稿' &&
        document.querySelector('[data-testid="schedule-prompt"]')?.value.includes('QUIT_DIRTY_DRAFT_ONLY')));

    const preview = operations.previewSchedule({ cadence: { kind: 'daily', timeZone: 'UTC', time: '09:00' } });
    const task = operations.createSchedule({ name: '退出后继续运行验收', prompt: 'SCHEDULE_QUIT_CONTINUE_DEMO synthetic resume check',
      workspaceId: null, attachmentIds: [], enabled: false, cadence: preview.cadence,
      allowReadTools: false, notification: 'none', expectedProviderBinding: preview.providerBinding });
    createdTaskId = task.id;
    const started = operations.runScheduleNow({ id: task.id, expectedRevision: task.revision });
    const run = await wait(async id => {
      const state = await window.muse.bootstrap();
      return state.scheduleRuns.find(run => run.id === id && run.status !== 'running');
    }, started.runId, 15000);
    check('A fresh paused schedule can dispatch and save a real local model result after cancelled quit',
      run.status === 'succeeded' && run.dispatchStarted && !store.getSchedule(task.id).enabled &&
      store.getChat(run.chatId).messages.at(-1).status === 'complete' &&
      store.getChat(run.chatId).messages.at(-1).content.length > 0);

    // A manual schedule does not itself exercise submitMessage's shutdown
    // fence, so also prove ordinary foreground requests remain admissible.
    await operations.sendMessage({ chatId: run.chatId, content: 'QUIT_CONTINUE_CHAT_DEMO synthetic follow-up after the aborted quit' });
    const continued = await wait(async id => {
      const chat = (await window.muse.bootstrap()).chats.find(chat => chat.id === id);
      return chat?.messages.length >= 4 && chat.messages.at(-1).status === 'complete' ? chat : false;
    }, run.chatId, 15000);
    check('Cancelled quit leaves ordinary chat admission and completion operational',
      continued.messages.at(-1).role === 'assistant' && continued.messages.at(-1).content.length > 0);

    await discardForm();
    await wait(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return !event.defaultPrevented;
    });
    check('Explicitly discarding the synthetic schedule draft clears its exit guard', !await exitGuard());
    await page(() => document.querySelector('[aria-label="关闭计划任务"]').click());
    await wait(() => !document.querySelector('[data-testid="schedule-panel"]'));
    operations.saveBackgroundSettings({ backgroundTasks: false, launchAtLogin: false });
    check('Quit cancellation fixture removes its tray and keeps login startup disabled',
      (await page(() => window.muse.bootstrap())).app.backgroundTrayActive === false &&
      (await page(() => window.muse.bootstrap())).app.launchAtLogin === false);
  } finally {
    dialog.showMessageBoxSync = originalDialog;
    app.removeListener('before-quit', beforeQuit);
    if (!window.isDestroyed()) {
      window.webContents.removeListener('will-prevent-unload', preventedUnload);
      try { await discardForm(); } catch { /* Preserve the original scenario failure. */ }
      try {
        if (await page(() => !!document.querySelector('[aria-label="关闭计划任务"]'))) {
          await page(() => document.querySelector('[aria-label="关闭计划任务"]').click());
        }
      } catch { /* The outer harness captures any still-open fixture state. */ }
    }
    if (createdTaskId) {
      try { operations.stopSchedule({ id: createdTaskId }); operations.deleteSchedule({ id: createdTaskId }); } catch {}
    }
    if (store.settings().backgroundTasks) operations.saveBackgroundSettings({ backgroundTasks: false, launchAtLogin: false });
  }
};
