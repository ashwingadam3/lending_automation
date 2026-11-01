// LenDenClub Auto-Filter - Popup Controller

document.addEventListener('DOMContentLoaded', async () => {
  const masterToggle = document.getElementById('master-toggle');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const countdownText = document.getElementById('countdown-text');
  const scheduleSummary = document.getElementById('schedule-summary');
  const bureauSummary = document.getElementById('bureau-summary');
  const lastRunSummary = document.getElementById('last-run-summary');
  const btnRunNow = document.getElementById('btn-run-now');
  const btnStop = document.getElementById('btn-stop');

  const modeHourly = document.getElementById('mode-hourly');
  const modeInterval = document.getElementById('mode-interval');
  const hourlyConfig = document.getElementById('hourly-config');
  const intervalConfig = document.getElementById('interval-config');
  const inputTargetMinutes = document.getElementById('input-target-minutes');
  const inputIntervalMins = document.getElementById('input-interval-mins');

  const catRepeat = document.getElementById('cat-repeat');
  const catFilling = document.getElementById('cat-filling');
  const catDaily = document.getElementById('cat-daily');
  const catMonthly = document.getElementById('cat-monthly');
  const optAutoDetect = document.getElementById('opt-auto-detect');

  // Options
  const inputMinScore = document.getElementById('input-min-score');
  const optAutoAdd = document.getElementById('opt-auto-add');
  const inputMaxLoans = document.getElementById('input-max-loans');
  const inputMaxSelect = document.getElementById('input-max-select');

  const inputDelay = document.getElementById('input-delay');
  const optAutoOpen = document.getElementById('opt-auto-open');
  const optFloatingHud = document.getElementById('opt-floating-hud');
  const optNotifications = document.getElementById('opt-notifications');

  const logConsole = document.getElementById('log-console');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  const btnCopyLogs = document.getElementById('btn-copy-logs');
  const saveStatus = document.getElementById('save-status');

  // Saved Loans Elements
  const savedCountBadge = document.getElementById('saved-count-badge');
  const btnResetSaved = document.getElementById('btn-reset-saved');
  const btnExportCsv = document.getElementById('btn-export-csv');
  const inputSavedSearch = document.getElementById('input-saved-search');
  const savedLoansContainer = document.getElementById('saved-loans-container');
  let allSavedLoans = [];

  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  const { settings, logs, isRunning, lastRunTime, lastRunStatus, lastRunMessage, nextRunTime } =
    await chrome.storage.local.get([
      'settings', 'logs', 'isRunning', 'lastRunTime', 'lastRunStatus', 'lastRunMessage', 'nextRunTime'
    ]);

  const currentSettings = Object.assign({
    enabled: true,
    scheduleMode: 'hourly_at_minute',
    targetMinutes: [1, 31],
    targetMinute: 31,
    intervalMinutes: 31,
    categories: ['Repeat Loans', 'Filling Fast', 'Earn Monthly'],
    autoDetectCategories: false,
    minBureauScore: 700,
    autoAddLoans: true,
    maxLoansPerCategory: 50,
    actionDelayMs: 1800,
    autoOpenTab: true,
    showFloatingHud: true,
    desktopNotifications: true
  }, settings || {});

  masterToggle.checked = currentSettings.enabled !== false;

  if (currentSettings.scheduleMode === 'interval') {
    modeInterval.checked = true;
    intervalConfig.style.display = 'flex';
    hourlyConfig.style.display = 'none';
  } else {
    modeHourly.checked = true;
    hourlyConfig.style.display = 'flex';
    intervalConfig.style.display = 'none';
  }

  const minsArr = currentSettings.targetMinutes || (currentSettings.targetMinute !== undefined ? [currentSettings.targetMinute] : [1, 31]);
  inputTargetMinutes.value = Array.isArray(minsArr) ? minsArr.join(', ') : '1, 31';
  inputIntervalMins.value = currentSettings.intervalMinutes ?? 31;

  const cats = currentSettings.categories || ['Repeat Loans', 'Filling Fast', 'Earn Monthly'];
  catRepeat.checked = cats.includes('Repeat Loans');
  catFilling.checked = cats.includes('Filling Fast');
  catMonthly.checked = cats.includes('Earn Monthly');
  catDaily.checked = cats.includes('Earn Daily'); // Unchecked by default

  optAutoDetect.checked = currentSettings.autoDetectCategories === true;

  inputMinScore.value = currentSettings.minBureauScore ?? 700;
  optAutoAdd.checked = currentSettings.autoAddLoans !== false;
  inputMaxLoans.value = currentSettings.maxLoansPerCategory ?? 50;
  inputMaxSelect.value = currentSettings.maxLoansToSelect ?? 50;

  inputDelay.value = currentSettings.actionDelayMs || 1800;
  optAutoOpen.checked = currentSettings.autoOpenTab !== false;
  optFloatingHud.checked = currentSettings.showFloatingHud !== false;
  optNotifications.checked = currentSettings.desktopNotifications !== false;

  updateScheduleSummary();
  updateStatusDisplay(isRunning, lastRunStatus, lastRunMessage);
  renderLogs(logs || []);
  loadSavedLoans();

  modeHourly.addEventListener('change', () => {
    hourlyConfig.style.display = 'flex';
    intervalConfig.style.display = 'none';
    saveSettings();
  });

  modeInterval.addEventListener('change', () => {
    intervalConfig.style.display = 'flex';
    hourlyConfig.style.display = 'none';
    saveSettings();
  });

  const autoSaveInputs = [
    masterToggle, inputTargetMinutes, inputIntervalMins,
    catRepeat, catFilling, catDaily, catMonthly, optAutoDetect,
    inputMinScore, optAutoAdd, inputMaxLoans, inputMaxSelect,
    inputDelay, optAutoOpen, optFloatingHud, optNotifications
  ];

  autoSaveInputs.forEach(input => {
    input.addEventListener('change', saveSettings);
  });

  async function saveSettings() {
    const selectedCats = [];
    if (catRepeat.checked) selectedCats.push('Repeat Loans');
    if (catFilling.checked) selectedCats.push('Filling Fast');
    if (catMonthly.checked) selectedCats.push('Earn Monthly');
    if (catDaily.checked) selectedCats.push('Earn Daily');

    const parsedMins = (inputTargetMinutes.value || '1, 31')
      .split(',')
      .map(m => parseInt(m.trim(), 10))
      .filter(m => !isNaN(m) && m >= 0 && m <= 59);
    const targetMinutes = parsedMins.length > 0 ? Array.from(new Set(parsedMins)).sort((a, b) => a - b) : [1, 31];

    const updated = {
      enabled: masterToggle.checked,
      scheduleMode: modeHourly.checked ? 'hourly_at_minute' : 'interval',
      targetMinutes: targetMinutes,
      targetMinute: targetMinutes[0],
      intervalMinutes: parseInt(inputIntervalMins.value || 31, 10),
      categories: selectedCats,
      autoDetectCategories: optAutoDetect.checked,
      minBureauScore: parseInt(inputMinScore.value || 700, 10),
      autoAddLoans: optAutoAdd.checked,
      maxLoansPerCategory: parseInt(inputMaxLoans.value || 50, 10),
      maxLoansToSelect: Math.min(300, Math.max(1, parseInt(inputMaxSelect.value || 50, 10))),
      actionDelayMs: parseInt(inputDelay.value || 1800, 10),
      autoOpenTab: optAutoOpen.checked,
      showFloatingHud: optFloatingHud.checked,
      desktopNotifications: optNotifications.checked
    };

    saveStatus.textContent = 'Saving...';
    await chrome.storage.local.set({ settings: updated });

    chrome.runtime.sendMessage({
      action: 'UPDATE_SETTINGS',
      settings: updated
    }, () => {
      saveStatus.textContent = 'Settings saved';
      setTimeout(() => { saveStatus.textContent = 'Synced'; }, 2000);
      updateScheduleSummary();
    });
  }

  function updateScheduleSummary() {
    if (!masterToggle.checked) {
      scheduleSummary.textContent = 'Disabled (Paused)';
      scheduleSummary.style.color = '#dc2626';
      countdownText.textContent = 'Automation Paused';
      return;
    }

    scheduleSummary.style.color = '';
    if (modeHourly.checked) {
      const parsedMins = (inputTargetMinutes.value || '1, 31')
        .split(',')
        .map(m => parseInt(m.trim(), 10))
        .filter(m => !isNaN(m) && m >= 0 && m <= 59);
      const displayMins = parsedMins.length > 0
        ? Array.from(new Set(parsedMins)).sort((a, b) => a - b).map(m => `:${String(m).padStart(2, '0')}`).join(', ')
        : ':01, :31';
      scheduleSummary.textContent = `Every hour at ${displayMins}`;
    } else {
      scheduleSummary.textContent = `Every ${inputIntervalMins.value || 31} minutes`;
    }

    bureauSummary.textContent = `Score > ${inputMinScore.value || 700} (Max select: ${inputMaxSelect.value || 50})`;
  }

  function updateStatusDisplay(running, status, message) {
    if (running) {
      statusDot.className = 'dot running';
      statusText.textContent = 'RUNNING';
      statusText.style.color = '#2563eb';
      btnRunNow.disabled = true;
      btnStop.disabled = false;
    } else {
      btnRunNow.disabled = false;
      // Allow Stop button to be clicked whenever schedule is active (masterToggle is on)
      btnStop.disabled = !masterToggle.checked;

      if (!masterToggle.checked) {
        statusDot.className = 'dot';
        statusText.textContent = 'PAUSED';
        statusText.style.color = '#dc2626';
      } else if (status === 'error') {
        statusDot.className = 'dot error';
        statusText.textContent = 'ERROR';
        statusText.style.color = '#dc2626';
      } else {
        statusDot.className = 'dot idle';
        statusText.textContent = 'IDLE';
        statusText.style.color = '#00875a';
      }
    }

    if (lastRunTime) {
      const date = new Date(lastRunTime);
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      lastRunSummary.textContent = `${timeStr} (${status === 'success' ? '✓ OK' : '⚠ Notice'})`;
      lastRunSummary.title = message || '';
    } else {
      lastRunSummary.textContent = 'No run recorded yet';
    }
  }

  function updateCountdown() {
    chrome.storage.local.get(['nextRunTime', 'isRunning', 'settings', 'lastRunStatus', 'lastRunMessage'], (res) => {
      if (res.settings && res.settings.enabled !== undefined) {
        masterToggle.checked = res.settings.enabled;
      }
      updateStatusDisplay(res.isRunning, res.lastRunStatus, res.lastRunMessage);

      if (!res.settings || !res.settings.enabled) {
        countdownText.textContent = 'Paused';
        return;
      }

      if (res.isRunning) {
        countdownText.textContent = 'Executing...';
        return;
      }

      const next = res.nextRunTime;
      if (!next) {
        countdownText.textContent = 'Pending schedule';
        return;
      }

      const diff = next - Date.now();
      if (diff <= 0) {
        countdownText.textContent = 'Due now';
      } else {
        const totalSecs = Math.floor(diff / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        const targetTimeStr = new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        countdownText.textContent = `Next: ${mins}m ${secs}s (${targetTimeStr})`;
      }
    });
  }

  setInterval(updateCountdown, 1000);
  updateCountdown();

  function renderLogs(logsList) {
    if (!logsList || logsList.length === 0) {
      logConsole.innerHTML = '<div class="log-entry info">No activity logged yet.</div>';
      return;
    }

    logConsole.innerHTML = logsList.map(item => `
      <div class="log-entry ${item.level}">
        <span style="opacity: 0.7;">[${item.timestamp}]</span> ${escapeHtml(item.message)}
      </div>
    `).join('');
  }

  function escapeHtml(text) {
    return (text || '')
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      if (changes.logs) {
        renderLogs(changes.logs.newValue || []);
      }
      if (changes.savedSelectedLoans) {
        allSavedLoans = changes.savedSelectedLoans.newValue || [];
        if (savedCountBadge) savedCountBadge.textContent = allSavedLoans.length;
        renderSavedLoans(allSavedLoans);
      }
      if (changes.isRunning || changes.lastRunStatus || changes.lastRunMessage) {
        chrome.storage.local.get(['isRunning', 'lastRunStatus', 'lastRunMessage'], (d) => {
          updateStatusDisplay(d.isRunning, d.lastRunStatus, d.lastRunMessage);
        });
      }
    }
  });

  let currentSavedFilter = 'all';

  const savedFilterAllCount = document.getElementById('saved-filter-all-count');
  const savedFilterAccCount = document.getElementById('saved-filter-acc-count');
  const savedFilterRejCount = document.getElementById('saved-filter-rej-count');

  function loadSavedLoans() {
    chrome.storage.local.get(['savedSelectedLoans'], (res) => {
      allSavedLoans = res.savedSelectedLoans || [];
      renderSavedLoans(allSavedLoans);
    });
  }

  function renderSavedLoans(loans) {
    if (!savedLoansContainer) return;

    const totalCount = loans.length;
    const accCount = loans.filter(l => (l.status || 'Accepted') === 'Accepted').length;
    const rejCount = loans.filter(l => l.status === 'Rejected').length;

    if (savedFilterAllCount) savedFilterAllCount.textContent = totalCount;
    if (savedFilterAccCount) savedFilterAccCount.textContent = accCount;
    if (savedFilterRejCount) savedFilterRejCount.textContent = rejCount;
    if (savedCountBadge) savedCountBadge.textContent = totalCount;

    // Filter by tab: all | accepted | rejected
    let list = loans;
    if (currentSavedFilter === 'accepted') {
      list = list.filter(l => (l.status || 'Accepted') === 'Accepted');
    } else if (currentSavedFilter === 'rejected') {
      list = list.filter(l => l.status === 'Rejected');
    }

    const query = (inputSavedSearch?.value || '').trim().toLowerCase();
    if (query) {
      list = list.filter(l => {
        return (l.name && l.name.toLowerCase().includes(query)) ||
               (l.loanId && l.loanId.toLowerCase().includes(query)) ||
               (l.category && l.category.toLowerCase().includes(query)) ||
               (l.status && l.status.toLowerCase().includes(query)) ||
               (l.reason && l.reason.toLowerCase().includes(query)) ||
               (String(l.bureauScore).includes(query));
      });
    }

    if (list.length === 0) {
      if (query) {
        savedLoansContainer.innerHTML = `
          <div class="saved-empty-state">
            <div class="empty-icon">🔍</div>
            <div class="empty-title">No matching loans</div>
            <div class="empty-desc">No saved loans match "${escapeHtml(query)}".</div>
          </div>`;
      } else {
        const filterName = currentSavedFilter === 'accepted' ? 'accepted' : currentSavedFilter === 'rejected' ? 'rejected' : 'inspected';
        savedLoansContainer.innerHTML = `
          <div class="saved-empty-state">
            <div class="empty-icon">📂</div>
            <div class="empty-title">No ${filterName} loans yet</div>
            <div class="empty-desc">When loans are evaluated (${currentSavedFilter === 'all' ? 'accepted or rejected' : currentSavedFilter}), they will appear here and are skipped in future cycles.</div>
          </div>`;
      }
      return;
    }

    savedLoansContainer.innerHTML = list.map(l => {
      const status = l.status || 'Accepted';
      const isAcc = status === 'Accepted';
      const statusBadge = isAcc
        ? `<span class="status-badge status-accepted">✓ Accepted</span>`
        : `<span class="status-badge status-rejected">✕ Rejected</span>`;
      const scoreClass = isAcc ? 'saved-loan-score' : 'saved-loan-score rejected';
      const timeStr = l.addedDate || (l.timestamp ? new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

      return `
        <div class="saved-loan-item">
          <div class="saved-loan-top">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="saved-loan-name">${escapeHtml(l.name)}</span>
              ${statusBadge}
            </div>
            <span class="${scoreClass}">Score: ${escapeHtml(String(l.bureauScore ?? 'N/A'))}</span>
          </div>
          ${l.reason ? `<div class="saved-loan-reason">${escapeHtml(l.reason)}</div>` : ''}
          <div class="saved-loan-bottom" style="margin-top: 2px;">
            <span class="saved-loan-id">${escapeHtml(l.loanId || 'N/A')}</span>
            <span class="saved-loan-cat">${escapeHtml(l.category || 'General')}</span>
            <span class="saved-loan-time" style="margin-left: auto;">${escapeHtml(timeStr)}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // Filter pill click handlers
  document.querySelectorAll('.saved-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.saved-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSavedFilter = btn.dataset.filter || 'all';
      renderSavedLoans(allSavedLoans);
    });
  });

  if (inputSavedSearch) {
    inputSavedSearch.addEventListener('input', () => {
      renderSavedLoans(allSavedLoans);
    });
  }

  if (btnResetSaved) {
    btnResetSaved.addEventListener('click', () => {
      const count = allSavedLoans.length;
      if (count === 0) {
        alert('There are no saved loans to reset.');
        return;
      }

      const confirmed = confirm(`Are you sure you want to reset all ${count} inspected loan(s)?\n\nThis will clear the history of both accepted and rejected loans so all loans become eligible to be inspected again in future runs.`);
      if (confirmed) {
        chrome.runtime.sendMessage({ action: 'RESET_SAVED_LOANS' }, () => {
          allSavedLoans = [];
          if (savedCountBadge) savedCountBadge.textContent = '0';
          renderSavedLoans([]);
        });
      }
    });
  }

  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', () => {
      if (!allSavedLoans || allSavedLoans.length === 0) {
        alert('No inspected loans to export.');
        return;
      }

      const headers = ['Status', 'Borrower Name', 'Loan ID', 'Bureau Score', 'Decision Reason', 'Category', 'Date Evaluated'];
      const rows = allSavedLoans.map(l => [
        escapeCsv(l.status || 'Accepted'),
        escapeCsv(l.name || ''),
        escapeCsv(l.loanId || ''),
        escapeCsv(l.bureauScore !== undefined ? l.bureauScore : ''),
        escapeCsv(l.reason || (l.status === 'Accepted' ? `Bureau Score ${l.bureauScore} > 700` : `Bureau Score ${l.bureauScore} <= 700`)),
        escapeCsv(l.category || ''),
        escapeCsv(l.addedDate || (l.timestamp ? new Date(l.timestamp).toLocaleString() : ''))
      ]);

      const csvContent = [headers.map(h => `"${h}"`).join(','), ...rows.map(r => r.join(','))].join('\r\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);

      const d = new Date();
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      link.setAttribute('download', `lendenclub_inspected_loans_${dateStr}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
  }

  function escapeCsv(val) {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  }

  btnRunNow.addEventListener('click', () => {
    btnRunNow.disabled = true;
    btnStop.disabled = false;
    chrome.runtime.sendMessage({ action: 'RUN_MANUAL' }, () => {
      masterToggle.checked = true;
      updateStatusDisplay(true, 'running', 'Manual cycle triggered');
      updateScheduleSummary();
    });
  });

  btnStop.addEventListener('click', () => {
    btnStop.disabled = true;
    chrome.runtime.sendMessage({ action: 'STOP_CYCLE' }, () => {
      masterToggle.checked = false;
      updateStatusDisplay(false, 'error', 'Stopped and paused by user');
      updateScheduleSummary();
      countdownText.textContent = 'Paused';
    });
  });

  btnClearLogs.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CLEAR_LOGS' }, () => {
      renderLogs([]);
    });
  });

  btnCopyLogs.addEventListener('click', async () => {
    const { logs } = await chrome.storage.local.get(['logs']);
    if (!logs || logs.length === 0) return;
    const text = logs.map(l => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
    await navigator.clipboard.writeText(text);
    btnCopyLogs.textContent = 'Copied!';
    setTimeout(() => { btnCopyLogs.textContent = 'Copy'; }, 1500);
  });
});
