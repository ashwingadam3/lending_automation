// LenDenClub Auto-Filter & Reload - Background Service Worker

const SCRIPT_VERSION = '2.9.0';
const ALARM_NAME = 'LENDEN_CYCLE_ALARM';

const DEFAULT_SETTINGS = {
  enabled: true,
  scheduleMode: 'hourly_at_minute', // runs at specific minutes of every hour
  targetMinutes: [1, 31],          // Run at every 1st and 31st minute of every hour
  targetMinute: 31,
  intervalMinutes: 31,
  categories: ['Repeat Loans', 'Filling Fast', 'Earn Monthly'], // Skipped Earn Daily
  autoDetectCategories: true,
  actionDelayMs: 1800,
  minBureauScore: 700,             // Bureau score threshold (>= 700)
  autoAddLoans: true,              // Auto-click "Add Loan" if score >= threshold
  maxLoansPerCategory: 50,         // Max borrower cards to inspect/check per category
  maxLoansToSelect: 50,            // Max loans to add/select per category (up to 300)
  selectMinAmount: true,           // Select ₹250 minimum lending amount per loan if available
  autoOpenTab: true,
  showFloatingHud: true,
  desktopNotifications: true
};

// Lifecycle: Install & Startup
chrome.runtime.onInstalled.addListener(async (details) => {
  addLog('Extension installed / updated: ' + details.reason, 'info');
  const stored = await chrome.storage.local.get(['settings']);
  let settings = Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
  if (settings.categories) {
    settings.categories = settings.categories.filter(c => !/Earn\s*Daily/i.test(c));
  }
  // Ensure default to [1, 31]
  if (!settings.targetMinutes || !Array.isArray(settings.targetMinutes) || settings.targetMinutes.length < 2) {
    settings.targetMinutes = [1, 31];
  }
  await chrome.storage.local.set({ settings });
  await scheduleNextAlarm(settings);
});

chrome.runtime.onStartup.addListener(async () => {
  addLog('Browser started - checking schedule...', 'info');
  const { settings } = await chrome.storage.local.get(['settings']);
  await scheduleNextAlarm(settings || DEFAULT_SETTINGS);
});

// Alarm Listener
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    addLog(`Scheduled alarm triggered (${new Date().toLocaleTimeString()}). Starting cycle...`, 'info');
    const { settings } = await chrome.storage.local.get(['settings']);
    if (settings && settings.enabled) {
      const targetMins = settings.targetMinutes || [1, 31];
      const nextTime = getNextTargetMinuteTimestamp(targetMins);
      await chrome.storage.local.set({ nextRunTime: nextTime });
    }
    await runAutomationCycle('alarm');
  }
});

function getNextTargetMinuteTimestamp(targetMinutes = [1, 31]) {
  const now = new Date();
  const validMins = Array.from(new Set(
    (Array.isArray(targetMinutes) ? targetMinutes : [targetMinutes])
      .map(m => parseInt(m, 10))
      .filter(m => !isNaN(m) && m >= 0 && m <= 59)
  )).sort((a, b) => a - b);

  if (validMins.length === 0) validMins.push(1, 31);

  const curHour = now.getHours();
  const curMin = now.getMinutes();

  // Find next target minute in current hour
  for (const min of validMins) {
    if (min > curMin) {
      const next = new Date(now);
      next.setMinutes(min, 0, 0);
      return next.getTime();
    }
  }

  // Otherwise wrap to first target minute of next hour
  const next = new Date(now);
  next.setHours(curHour + 1);
  next.setMinutes(validMins[0], 0, 0);
  return next.getTime();
}

async function scheduleNextAlarm(settings) {
  try {
    await chrome.alarms.clear(ALARM_NAME);

    if (!settings || !settings.enabled) {
      addLog('Automation is disabled. Alarm paused.', 'warn');
      await chrome.storage.local.set({ nextRunTime: null, isRunning: false });
      return;
    }

    let nextTimestamp;
    if (settings.scheduleMode === 'interval') {
      const mins = Math.max(1, parseInt(settings.intervalMinutes || 31, 10));
      nextTimestamp = Date.now() + mins * 60 * 1000;
      chrome.alarms.create(ALARM_NAME, {
        when: nextTimestamp
      });
      addLog(`Scheduled interval alarm: every ${mins} minute(s). Next run at ${new Date(nextTimestamp).toLocaleTimeString()}`, 'info');
    } else {
      const targetMins = settings.targetMinutes || (settings.targetMinute !== undefined ? [settings.targetMinute] : [1, 31]);
      nextTimestamp = getNextTargetMinuteTimestamp(targetMins);

      chrome.alarms.create(ALARM_NAME, {
        when: nextTimestamp
      });
      const minsStr = (Array.isArray(targetMins) ? targetMins : [targetMins]).map(m => `:${String(m).padStart(2, '0')}`).join(', ');
      addLog(`Scheduled alarm at ${minsStr} of every hour. Next run at ${new Date(nextTimestamp).toLocaleTimeString()}`, 'info');
    }

    await chrome.storage.local.set({ nextRunTime: nextTimestamp });
  } catch (err) {
    console.error('Error scheduling alarm:', err);
  }
}

// Master Automation Trigger
async function runAutomationCycle(source = 'manual') {
  const { settings, isRunning } = await chrome.storage.local.get(['settings', 'isRunning']);
  const currentSettings = Object.assign({}, DEFAULT_SETTINGS, settings || {});

  if (isRunning && source !== 'manual') {
    addLog('A cycle is already in progress. Skipping redundant trigger.', 'warn');
    return;
  }

  await chrome.storage.local.set({
    isRunning: true,
    lastRunStatus: 'running',
    currentCategory: 'Starting...'
  });

  addLog(`Initiating LenDenClub auto-filter cycle (Trigger: ${source})...`, 'info');

  try {
    let tabs = await chrome.tabs.query({ url: "*://*.lendenclub.com/*" });
    let targetTab = null;

    if (tabs && tabs.length > 0) {
      targetTab = tabs.find(t => t.active) || tabs[0];
      addLog(`Found open LenDenClub tab (ID: ${targetTab.id}, URL: ${targetTab.url})`, 'info');
    } else if (currentSettings.autoOpenTab) {
      addLog('No open LenDenClub tab found. Opening a background tab...', 'info');
      targetTab = await chrome.tabs.create({
        url: "https://app.lendenclub.com/dashboard",
        active: false
      });
      await waitForTabLoad(targetTab.id);
      await new Promise(r => setTimeout(r, 4000));
    } else {
      throw new Error('No LenDenClub tab is open. Please open https://app.lendenclub.com or enable Auto-Open in settings.');
    }

    let pingSucceeded = false;
    try {
      const resp = await chrome.tabs.sendMessage(targetTab.id, { action: "PING" });
      if (resp && resp.status === 'pong' && resp.version === SCRIPT_VERSION) {
        pingSucceeded = true;
      } else {
        addLog(`Updating LenDenClub tab with latest automation engine (v${SCRIPT_VERSION}). Reloading page...`, 'info');
        await chrome.tabs.reload(targetTab.id);
        await waitForTabLoad(targetTab.id);
        await new Promise(r => setTimeout(r, 2500));
        pingSucceeded = true;
      }
    } catch (e) {
      pingSucceeded = false;
    }

    if (!pingSucceeded) {
      // A dead/orphaned script (e.g. after the extension was reloaded) can block re-injection,
      // so reload the tab to get a fresh content script from the manifest.
      addLog('Connecting script to LenDenClub tab (reloading page for a fresh script)...', 'info');
      try {
        await chrome.tabs.reload(targetTab.id);
        await waitForTabLoad(targetTab.id);
        await new Promise(r => setTimeout(r, 2500));
        const resp2 = await chrome.tabs.sendMessage(targetTab.id, { action: "PING" }).catch(() => null);
        if (resp2 && resp2.status === 'pong') pingSucceeded = true;
      } catch (reloadErr) {
        console.warn('Tab reload notice:', reloadErr.message);
      }
    }

    if (!pingSucceeded) {
      addLog('Injecting script into LenDenClub tab...', 'info');
      try {
        if (chrome.scripting && chrome.scripting.executeScript) {
          await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            files: ['content.js']
          });
          await chrome.scripting.insertCSS({
            target: { tabId: targetTab.id },
            files: ['content.css']
          });
        }
      } catch (injectionErr) {
        console.warn('Script injection notice:', injectionErr.message);
      }
      await new Promise(r => setTimeout(r, 800));
    }

    addLog(`Sending RUN_CYCLE command to tab ${targetTab.id}...`, 'info');
    chrome.tabs.sendMessage(targetTab.id, {
      action: "RUN_CYCLE",
      settings: currentSettings
    }, async (response) => {
      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message;
        addLog(`Page communication notice: ${errorMsg}. Refresh the LenDenClub tab if needed.`, 'warn');
        await finishCycle(false, `Please refresh LenDenClub tab: ${errorMsg}`, currentSettings);
      } else if (response && response.status === 'started') {
        addLog('Page acknowledged cycle start.', 'info');
      }
    });

  } catch (err) {
    addLog(`Cycle initialization notice: ${err.message}`, 'error');
    await finishCycle(false, err.message, currentSettings);
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function finishCycle(success, message, settings) {
  const now = new Date();
  await chrome.storage.local.set({
    isRunning: false,
    currentCategory: '',
    lastRunTime: now.getTime(),
    lastRunStatus: success ? 'success' : 'error',
    lastRunMessage: message
  });

  addLog(`Cycle finished: ${message}`, success ? 'success' : 'error');
  await scheduleNextAlarm(settings);

  if (settings && settings.desktopNotifications) {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: success ? 'LenDenClub Automation Done' : 'LenDenClub Automation Notice',
        message: message
      });
    } catch (e) {}
  }
}

async function addLog(message, level = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const entry = { id: Date.now() + Math.random(), timestamp, message, level };
  console.log(`[LenDenClub ${level.toUpperCase()} ${timestamp}] ${message}`);

  try {
    const data = await chrome.storage.local.get(['logs']);
    const logs = data.logs || [];
    logs.unshift(entry);
    if (logs.length > 150) logs.length = 150;
    await chrome.storage.local.set({ logs });
  } catch (err) {
    console.error('Failed to save log', err);
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'RUN_MANUAL') {
    (async () => {
      const { settings } = await chrome.storage.local.get(['settings']);
      // If automation was paused, re-enable it on manual run
      if (settings && !settings.enabled) {
        settings.enabled = true;
        await chrome.storage.local.set({ settings });
      }
      runAutomationCycle('manual');
    })();
    sendResponse({ status: 'started' });
    return false;
  }

  if (request.action === 'STOP_CYCLE') {
    (async () => {
      // 1. Immediately signal FORCE_STOP to all LenDenClub tabs
      try {
        const tabs = await chrome.tabs.query({ url: "*://*.lendenclub.com/*" });
        for (const t of tabs) {
          chrome.tabs.sendMessage(t.id, { action: "FORCE_STOP" }).catch(() => {});
        }
      } catch (e) {}

      // 2. Pause automation and cancel all alarms
      const { settings } = await chrome.storage.local.get(['settings']);
      const updatedSettings = Object.assign({}, DEFAULT_SETTINGS, settings || {}, { enabled: false });
      await chrome.alarms.clearAll();

      await chrome.storage.local.set({
        settings: updatedSettings,
        isRunning: false,
        nextRunTime: null,
        currentCategory: '',
        lastRunTime: Date.now(),
        lastRunStatus: 'error',
        lastRunMessage: 'Stopped and paused by user'
      });

      addLog('★ Automation stopped and paused by user. Next schedule cancelled.', 'warn');
      sendResponse({ status: 'stopped' });
    })();
    return true;
  }

  if (request.action === 'LOG_EVENT') {
    addLog(request.message, request.level || 'info');
    sendResponse({ status: 'ok' });
    return false;
  }

  if (request.action === 'CYCLE_COMPLETED') {
    (async () => {
      const { settings } = await chrome.storage.local.get(['settings']);
      // If cycle was stopped by user, do NOT reschedule
      if (request.message && (request.message.includes('Stopped by user') || request.message.includes('Automation stopped'))) {
        sendResponse({ status: 'ignored' });
        return;
      }
      await finishCycle(request.success, request.message, settings || DEFAULT_SETTINGS);
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (request.action === 'UPDATE_SETTINGS') {
    (async () => {
      await chrome.storage.local.set({ settings: request.settings });
      await scheduleNextAlarm(request.settings);
      addLog('Settings updated and alarm rescheduled.', 'info');
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (request.action === 'SAVE_SELECTED_LOAN' || request.action === 'RECORD_LOAN_EVALUATION') {
    (async () => {
      try {
        const { savedSelectedLoans = [] } = await chrome.storage.local.get(['savedSelectedLoans']);
        const loan = request.loan;
        if (loan && loan.name) {
          const normName = loan.name.toLowerCase().replace(/^(mr|ms|mrs|miss)\.?\s+/i, '').replace(/\s+/g, ' ').trim();
          const existingIndex = savedSelectedLoans.findIndex(item => {
            const itemNorm = (item.name || '').toLowerCase().replace(/^(mr|ms|mrs|miss)\.?\s+/i, '').replace(/\s+/g, ' ').trim();
            if (loan.loanId && item.loanId && loan.loanId === item.loanId) return true;
            return itemNorm === normName;
          });

          const status = loan.status || 'Accepted';
          const reason = loan.reason || (status === 'Accepted' ? `Bureau Score ${loan.bureauScore} >= threshold` : `Bureau Score ${loan.bureauScore} < threshold`);

          const record = {
            name: loan.name,
            loanId: loan.loanId || `LDC-${Date.now().toString(36).toUpperCase()}`,
            bureauScore: loan.bureauScore,
            category: loan.category || 'General',
            status: status,
            reason: reason,
            timestamp: loan.timestamp || Date.now(),
            addedDate: loan.addedDate || new Date(loan.timestamp || Date.now()).toLocaleString()
          };

          if (existingIndex >= 0) {
            if (status === 'Accepted' || savedSelectedLoans[existingIndex].status !== 'Accepted') {
              savedSelectedLoans[existingIndex] = record;
            }
          } else {
            savedSelectedLoans.unshift(record);
          }

          await chrome.storage.local.set({ savedSelectedLoans });
          if (status === 'Accepted') {
            addLog(`Saved "${loan.name}" (Accepted, Score: ${loan.bureauScore}, ID: ${loan.loanId}) to history.`, 'info');
          }
        }
      } catch (e) {
        console.error('Failed to save loan evaluation:', e);
      }
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (request.action === 'SAVE_SELECTED_LOANS_BATCH') {
    (async () => {
      try {
        const loans = Array.isArray(request.loans) ? request.loans : [];
        if (loans.length > 0) {
          const { savedSelectedLoans = [] } = await chrome.storage.local.get(['savedSelectedLoans']);
          let addedOrUpdated = 0;

          for (const loan of loans) {
            if (!loan || !loan.name) continue;
            const normName = loan.name.toLowerCase().replace(/^(mr|ms|mrs|miss)\.?\s+/i, '').replace(/\s+/g, ' ').trim();
            const existingIndex = savedSelectedLoans.findIndex(item => {
              const itemNorm = (item.name || '').toLowerCase().replace(/^(mr|ms|mrs|miss)\.?\s+/i, '').replace(/\s+/g, ' ').trim();
              if (loan.loanId && item.loanId && loan.loanId === item.loanId) return true;
              return itemNorm === normName;
            });

            const status = loan.status || 'Accepted';
            const reason = loan.reason || (status === 'Accepted' ? `Bureau Score ${loan.bureauScore} >= threshold` : `Bureau Score ${loan.bureauScore} < threshold`);
            const ts = loan.timestamp || Date.now();

            const record = {
              name: loan.name,
              loanId: loan.loanId || `LDC-${ts.toString(36).toUpperCase()}`,
              bureauScore: loan.bureauScore,
              category: loan.category || 'General',
              status: status,
              reason: reason,
              timestamp: ts,
              addedDate: loan.addedDate || new Date(ts).toLocaleString()
            };

            if (existingIndex >= 0) {
              savedSelectedLoans[existingIndex] = record;
            } else {
              savedSelectedLoans.unshift(record);
            }
            addedOrUpdated++;
          }

          await chrome.storage.local.set({ savedSelectedLoans });
          addLog(`★ Saved ${addedOrUpdated} committed loan(s) to history after Continue.`, 'success');
        }
      } catch (e) {
        console.error('Failed to save loan batch:', e);
      }
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (request.action === 'DELETE_SAVED_LOAN') {
    (async () => {
      try {
        const { savedSelectedLoans = [] } = await chrome.storage.local.get(['savedSelectedLoans']);
        const targetId = request.loanId || '';
        const targetName = (request.name || '').toLowerCase().trim();
        const targetTs = request.timestamp;

        const idx = savedSelectedLoans.findIndex(l => {
          if (targetTs && l.timestamp === targetTs && (l.name || '').toLowerCase().trim() === targetName) return true;
          if (targetId && l.loanId === targetId) return true;
          return (l.name || '').toLowerCase().trim() === targetName;
        });

        if (idx >= 0) {
          const removed = savedSelectedLoans.splice(idx, 1)[0];
          await chrome.storage.local.set({ savedSelectedLoans });
          addLog(`Removed "${removed.name}" (${removed.loanId || 'N/A'}) from saved history.`, 'info');
        }
      } catch (e) {
        console.error('Failed to delete saved loan:', e);
      }
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (request.action === 'DELETE_SAVED_LOANS_BULK') {
    (async () => {
      try {
        const { savedSelectedLoans = [] } = await chrome.storage.local.get(['savedSelectedLoans']);
        const keysToRemove = new Set(Array.isArray(request.keys) ? request.keys : []);
        const beforeCount = savedSelectedLoans.length;

        const remaining = savedSelectedLoans.filter(l => {
          const key = `${l.loanId || ''}|${(l.name || '').toLowerCase().trim()}|${l.timestamp || ''}`;
          return !keysToRemove.has(key);
        });

        const removedCount = beforeCount - remaining.length;
        await chrome.storage.local.set({ savedSelectedLoans: remaining });
        addLog(`★ Removed ${removedCount} loan(s) from saved history. They are now re-eligible for future runs.`, 'info');
        sendResponse({ status: 'ok', removedCount });
      } catch (e) {
        console.error('Failed to bulk delete saved loans:', e);
        sendResponse({ status: 'error' });
      }
    })();
    return true;
  }

  if (request.action === 'TOGGLE_SAVED_LOAN_STATUS') {
    (async () => {
      try {
        const { savedSelectedLoans = [] } = await chrome.storage.local.get(['savedSelectedLoans']);
        const targetId = request.loanId || '';
        const targetName = (request.name || '').toLowerCase().trim();
        const targetTs = request.timestamp;

        const idx = savedSelectedLoans.findIndex(l => {
          if (targetTs && l.timestamp === targetTs && (l.name || '').toLowerCase().trim() === targetName) return true;
          if (targetId && l.loanId === targetId) return true;
          return (l.name || '').toLowerCase().trim() === targetName;
        });

        if (idx >= 0) {
          const item = savedSelectedLoans[idx];
          const newStatus = (item.status || 'Accepted') === 'Accepted' ? 'Rejected' : 'Accepted';
          item.status = newStatus;
          item.reason = `Manually marked as ${newStatus} (Score: ${item.bureauScore ?? 'N/A'})`;
          await chrome.storage.local.set({ savedSelectedLoans });
          addLog(`Updated "${item.name}" status to ${newStatus} in saved history.`, 'info');
        }
      } catch (e) {
        console.error('Failed to toggle saved loan status:', e);
      }
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (request.action === 'GET_SAVED_LOANS') {
    (async () => {
      const { savedSelectedLoans = [] } = await chrome.storage.local.get(['savedSelectedLoans']);
      sendResponse({ savedLoans: savedSelectedLoans });
    })();
    return true;
  }

  if (request.action === 'RESET_SAVED_LOANS') {
    (async () => {
      await chrome.storage.local.set({ savedSelectedLoans: [] });
      addLog('★ Reset saved selected loans list. All previous loans are now re-eligible.', 'info');
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (request.action === 'CLEAR_LOGS') {
    chrome.storage.local.set({ logs: [] }).then(() => {
      sendResponse({ status: 'ok' });
    });
    return true;
  }

  if (request.action === 'GET_NEXT_RUN') {
    chrome.storage.local.get(['nextRunTime', 'isRunning', 'lastRunTime', 'lastRunStatus']).then(data => {
      sendResponse(data);
    });
    return true;
  }
});
