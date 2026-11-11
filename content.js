// LenDenClub Auto-Filter & Smart Loan Picker - Content Script

(() => {
  const CONTENT_SCRIPT_VERSION = '2.8.0';

  if (window.__LENDEN_AUTO_INJECTED__) {
    return;
  }
  window.__LENDEN_AUTO_INJECTED__ = true;

  console.log(`[LenDenClub Automator v${CONTENT_SCRIPT_VERSION}] Content script loaded on`, window.location.href);

  let isCycleRunning = false;
  let stopRequested = false;
  let activeSleepReject = null;
  let currentSettings = null;
  let hudElement = null;
  let hudMinimized = true;

  // Listen for messages from background / popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'PING') {
      sendResponse({ status: 'pong', version: CONTENT_SCRIPT_VERSION, isRunning: isCycleRunning });
      return false;
    }

    if (request.action === 'RUN_CYCLE') {
      if (isCycleRunning) {
        sendResponse({ status: 'already_running' });
        return false;
      }
      stopRequested = false;
      currentSettings = request.settings;
      sendResponse({ status: 'started' });
      startAutomationCycle(request.settings);
      return false;
    }

    if (request.action === 'FORCE_STOP') {
      stopRequested = true;
      isCycleRunning = false;

      // Abort any active sleep delay immediately
      if (activeSleepReject) {
        try { activeSleepReject(); } catch (e) {}
        activeSleepReject = null;
      }

      // Close any open borrower popup immediately
      try {
        const modal = getOpenBorrowerDetailsModal();
        if (modal) {
          closeBorrowerModalAndWait(modal).catch(() => {});
        }
      } catch (e) {}

      updateHudStatus('error', 'Stopped by user');
      logEvent('★ Cycle immediately stopped by user.', 'warn');
      sendResponse({ status: 'stopped' });
      return false;
    }

    return false;
  });

  function sleep(ms) {
    if (stopRequested) {
      return Promise.reject(new Error('Stopped by user'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        activeSleepReject = null;
        resolve();
      }, ms);
      activeSleepReject = () => {
        clearTimeout(timer);
        activeSleepReject = null;
        reject(new Error('Stopped by user'));
      };
    });
  }

  function logEvent(message, level = 'info') {
    console.log(`[LenDenClub ${level.toUpperCase()}]`, message);
    try {
      chrome.runtime.sendMessage({
        action: 'LOG_EVENT',
        message: message,
        level: level
      }).catch(() => {});
    } catch (e) {}

    updateHudStep(message);
  }

  // -------------------------------------------------------------
  // LEAF-NODE SELECTOR ENGINE
  // -------------------------------------------------------------

  function findLeafElementByText(regex, container = document.body) {
    if (!container) return null;
    const all = Array.from(container.querySelectorAll('*'));
    
    const matching = [];
    for (const el of all) {
      if (el === document.body || el.id === 'root' || el.id === '__next' || el.id === 'lenden-auto-hud') {
        continue;
      }
      if (el.closest('#lenden-auto-hud')) continue;

      const t = (el.innerText || el.textContent || '').trim();
      if (regex.test(t)) {
        matching.push(el);
      }
    }

    for (let i = matching.length - 1; i >= 0; i--) {
      const el = matching[i];
      const hasMatchingChild = Array.from(el.children).some(child => {
        if (child.closest('#lenden-auto-hud')) return false;
        const ct = (child.innerText || child.textContent || '').trim();
        return regex.test(ct);
      });
      if (!hasMatchingChild) {
        return el;
      }
    }

    return null;
  }

  function triggerRealClick(element) {
    if (!element) return false;
    try {
      element.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
    } catch (e) {}

    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const downInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: 1,
      clientX: clientX,
      clientY: clientY,
      screenX: window.screenX + clientX,
      screenY: window.screenY + clientY,
      button: 0,
      buttons: 1,
      which: 1
    };

    const upInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: 1,
      clientX: clientX,
      clientY: clientY,
      screenX: window.screenX + clientX,
      screenY: window.screenY + clientY,
      button: 0,
      buttons: 0,
      which: 1
    };

    try {
      element.dispatchEvent(new PointerEvent('pointerover', { ...upInit, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      element.dispatchEvent(new MouseEvent('mouseover', upInit));
      element.dispatchEvent(new PointerEvent('pointerdown', { ...downInit, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      element.dispatchEvent(new MouseEvent('mousedown', downInit));
      element.dispatchEvent(new PointerEvent('pointerup', { ...upInit, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      element.dispatchEvent(new MouseEvent('mouseup', upInit));
    } catch (e) {}

    // Fire EXACTLY ONE click. Never dispatchEvent + .click() on the same element,
    // which would toggle "Add Loan" on and then immediately off!
    try {
      if (typeof element.click === 'function') {
        element.click();
      } else {
        element.dispatchEvent(new MouseEvent('click', upInit));
      }
    } catch (e) {}

    return true;
  }

  async function waitFor(predicate, timeoutMs = 8000, stepMs = 300) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (stopRequested) throw new Error('Automation stopped');
      try {
        const found = predicate();
        if (found) return found;
      } catch (e) {}
      await sleep(stepMs);
    }
    return null;
  }

  // -------------------------------------------------------------
  // DASHBOARD & CATEGORY DOM HELPERS
  // -------------------------------------------------------------

  function findTrendingCategorySection() {
    const leaf = findLeafElementByText(/^Trending\s+category$/i);
    if (leaf) {
      return leaf.closest('div, section') || leaf.parentElement;
    }
    return null;
  }

  // Scoped to the actual Trending category container at the top of Dashboard
  function getTrendingContainer() {
    const heading = findLeafElementByText(/^Trending\s+category$/i);
    if (!heading) return null;
    let el = heading.parentElement;
    for (let i = 0; i < 10 && el && el !== document.body; i++) {
      const t = el.innerText || '';
      if (/Repeat\s*Loans/i.test(t) && /Filling\s*Fast/i.test(t) && /Earn\s*Monthly/i.test(t)) {
        return el;
      }
      el = el.parentElement;
    }
    return heading.closest('div, section') || heading.parentElement;
  }

  function isOnMainCategoriesPage() {
    if (findTrendingCategorySection()) return true;

    const hasRepeat = !!findLeafElementByText(/^Repeat\s*Loans$/i);
    const hasFilling = !!findLeafElementByText(/^Filling\s*Fast$/i);
    const hasMonthly = !!findLeafElementByText(/^Earn\s*Monthly$/i);

    if ((hasRepeat && hasFilling) || (hasRepeat && hasMonthly) || (hasFilling && hasMonthly)) {
      return true;
    }

    return false;
  }

  function detectAvailableCategories() {
    const defaultList = ['Repeat Loans', 'Filling Fast', 'Earn Monthly'];
    const found = [];

    for (const name of defaultList) {
      if (findLeafElementByText(new RegExp(name.replace(/\s+/g, '\\s*'), 'i'))) {
        found.push(name);
      }
    }

    const result = found.length > 0 ? found : defaultList;

    // Live Loans lives in the top navigation bar, not the Trending category box
    if (getLiveLoansNavClickTargets().length > 0) {
      result.push('Live Loans');
    }

    return result;
  }

  function findCategoryIconByGeometry(leafTextElement, scope = document.body) {
    if (!leafTextElement) return null;
    const textRect = leafTextElement.getBoundingClientRect();
    const textCenterX = textRect.left + textRect.width / 2;

    const allImgs = Array.from(scope.querySelectorAll('img, svg'));
    let bestMatch = null;
    let minDistance = 999999;

    for (const el of allImgs) {
      if (el.closest('#lenden-auto-hud')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 14 || r.height < 14 || r.width > 120 || r.height > 120) continue;

      const imgCenterX = r.left + r.width / 2;
      const xDiff = Math.abs(imgCenterX - textCenterX);
      const yDiff = textRect.top - r.bottom;

      if (xDiff <= 55 && yDiff >= -25 && yDiff <= 140) {
        const dist = xDiff * 2 + Math.abs(yDiff);
        if (dist < minDistance) {
          minDistance = dist;
          bestMatch = el;
        }
      }
    }

    return bestMatch;
  }

  // -------------------------------------------------------------
  // LIVE LOANS (TOP NAVIGATION BAR) HELPERS
  // -------------------------------------------------------------

  function isLiveLoansCategory(categoryName) {
    return /^Live\s*Loans?$/i.test((categoryName || '').trim());
  }

  // Click targets for the "Live loans" item in the top navigation bar (opens /manual-lending)
  function getLiveLoansNavClickTargets() {
    const targets = [];
    const push = (el, desc) => {
      if (!el || el === document.body || el.id === 'root' || el.id === '__next') return;
      if (el.closest('#lenden-auto-hud')) return;
      if (targets.some(t => t.el === el)) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      targets.push({ el, desc });
    };

    const liveRegex = /^Live\s*loans$/i;
    const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();

    // 1. Leaf elements whose text is exactly "Live loans" (prefer header/nav, then closest to top of page)
    const leaves = Array.from(document.querySelectorAll('*')).filter(el => {
      if (el.closest('#lenden-auto-hud')) return false;
      if (!liveRegex.test(textOf(el))) return false;
      return !Array.from(el.children).some(c => liveRegex.test(textOf(c)));
    });
    leaves.sort((a, b) => {
      const aNav = !!a.closest('header, nav');
      const bNav = !!b.closest('header, nav');
      if (aNav !== bNav) return aNav ? -1 : 1;
      return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    });

    // 2. Direct links to the Live loans page
    const hrefLinks = Array.from(document.querySelectorAll('a[href*="manual-lending"]'));
    for (const a of hrefLinks) {
      push(a, `Live loans Link (${a.tagName} → ${a.getAttribute('href')})`);
    }

    for (const leaf of leaves) {
      const clickable = leaf.closest('a, button, [role="button"], [role="link"], [role="tab"], li');
      push(clickable, `Live loans Nav Item (${clickable ? clickable.tagName : ''})`);
      push(leaf, `Live loans Text Label (${leaf.tagName})`);
      if (leaf.parentElement && leaf.parentElement.querySelector('svg, img')) {
        push(leaf.parentElement, `Live loans Nav Wrapper (${leaf.parentElement.tagName})`);
      }
    }

    return targets;
  }

  // Category targets strictly inside the Trending Category box
  function getCategoryClickTargets(categoryName) {
    // Live Loans is opened from the top navigation bar (not the Trending category box);
    // everything after opening it follows the exact same category flow.
    if (isLiveLoansCategory(categoryName)) {
      return getLiveLoansNavClickTargets();
    }

    const reg = new RegExp(categoryName.replace(/\s+/g, '\\s*'), 'i');
    const trending = getTrendingContainer() || document.body;

    let leaf = null;
    if (trending) {
      const candidates = Array.from(trending.querySelectorAll('*'));
      for (const el of candidates) {
        if (el.closest('#lenden-auto-hud')) continue;
        const t = (el.innerText || el.textContent || '').trim();
        if (reg.test(t)) {
          const hasChild = Array.from(el.children).some(c => reg.test((c.innerText || c.textContent || '').trim()));
          if (!hasChild) {
            leaf = el;
            break;
          }
        }
      }
    }

    if (!leaf) {
      leaf = findLeafElementByText(reg);
    }
    if (!leaf) return [];

    const targets = [];

    // Find the dedicated column / card container for this category
    // It is the highest ancestor of `leaf` that does NOT contain other category names
    const otherCategories = ['Repeat Loans', 'Filling Fast', 'Earn Daily', 'Earn Monthly']
      .filter(c => !reg.test(c));

    let columnCard = leaf;
    let curr = leaf.parentElement;
    while (curr && curr !== trending && curr !== document.body) {
      const t = curr.innerText || '';
      const containsOther = otherCategories.some(other => new RegExp(other.replace(/\s+/g, '\\s*'), 'i').test(t));
      if (containsOther) break;
      columnCard = curr;
      curr = curr.parentElement;
    }

    // 1. Any Circle Icon (IMG, SVG) inside this columnCard
    const columnIcons = Array.from(columnCard.querySelectorAll('img, svg'));
    for (const icon of columnIcons) {
      if (!targets.some(t => t.el === icon)) {
        targets.push({ el: icon, desc: `Circle Icon (${icon.tagName})` });
        if (icon.parentElement && icon.parentElement !== columnCard) {
          targets.push({ el: icon.parentElement, desc: `Circle Icon Wrapper (${icon.parentElement.tagName})` });
        }
      }
    }

    // 2. Geometrically aligned Circle Icon as fallback
    const geoIcon = findCategoryIconByGeometry(leaf, trending);
    if (geoIcon && !targets.some(t => t.el === geoIcon)) {
      targets.push({ el: geoIcon, desc: `Circle Icon Geo (${geoIcon.tagName})` });
      if (geoIcon.parentElement && geoIcon.parentElement !== document.body) {
        targets.push({ el: geoIcon.parentElement, desc: `Circle Icon Wrapper (${geoIcon.parentElement.tagName})` });
      }
    }

    // 3. Preceding siblings inside the card
    let probe = leaf;
    for (let k = 0; k < 4; k++) {
      let sib = probe.previousElementSibling;
      while (sib) {
        const imgOrSvg = sib.matches('img, svg') ? sib : sib.querySelector('img, svg, canvas');
        if (imgOrSvg && !targets.some(t => t.el === imgOrSvg)) {
          targets.push({ el: imgOrSvg, desc: `Circle Icon Sibling (${imgOrSvg.tagName})` });
        }
        sib = sib.previousElementSibling;
      }
      probe = probe.parentElement;
      if (!probe || probe === document.body || probe.id === 'root') break;
    }

    // 4. Category card container
    if (columnCard && columnCard !== leaf && !targets.some(t => t.el === columnCard)) {
      targets.push({ el: columnCard, desc: `Card Container (${columnCard.tagName})` });
    }

    // 5. Any link or button inside or enclosing
    const linkOrBtn = columnCard.querySelector('a, button, [role="button"]') || columnCard.closest('a, button, [role="button"]');
    if (linkOrBtn && !targets.some(t => t.el === linkOrBtn)) {
      targets.push({ el: linkOrBtn, desc: `Link/Button (${linkOrBtn.tagName})` });
    }

    // 6. The text label itself
    if (leaf && !targets.some(t => t.el === leaf)) {
      targets.push({ el: leaf, desc: `Text Label (${leaf.tagName})` });
    }

    return targets;
  }

  function findFilterSortButton() {
    const leaf = findLeafElementByText(/Filter\s*(&|and)\s*Sort/i);
    if (leaf) {
      return leaf.closest('button, [role="button"], a') || leaf.parentElement || leaf;
    }

    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
    for (const el of candidates) {
      if (el.closest('#lenden-auto-hud')) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (/Filter(\s*(&|and)\s*Sort)?/i.test(text)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 25 && rect.width < 260 && rect.height > 18 && rect.height < 90) {
          return el.closest('button, [role="button"]') || el;
        }
      }
    }

    const svgs = Array.from(document.querySelectorAll('svg, i'));
    for (const s of svgs) {
      if (s.closest('#lenden-auto-hud')) continue;
      const parent = s.closest('button, [role="button"], a, div');
      if (parent) {
        const text = (parent.innerText || parent.textContent || '').trim();
        if (/Filter/i.test(text)) {
          return parent;
        }
      }
    }

    return null;
  }

  function isFilterModalOpen() {
    const applyBtn = findApplyButton();
    const leafTitle = findLeafElementByText(/Filter\s*(&|and)\s*Sort/i);
    return !!applyBtn && !!leafTitle;
  }

  function findReloadFiltersButton() {
    const leaf = findLeafElementByText(/Click\s+to\s+load/i);
    if (leaf) {
      return leaf.closest('button, [role="button"], a') || leaf;
    }

    const textLeaf = findLeafElementByText(/Re-?load the same filters/i);
    if (textLeaf) {
      const container = textLeaf.closest('div, section') || textLeaf.parentElement;
      if (container) {
        const btn = container.querySelector('button, [role="button"], a');
        if (btn) return btn;
      }
    }
    return null;
  }

  function isFiltersAlreadyLoaded() {
    const leaf = findLeafElementByText(/Last used filters & sort loaded/i);
    return !!leaf;
  }

  function findApplyButton() {
    const leaf = findLeafElementByText(/^Apply(\s*\(\d+\))?$/i);
    if (leaf) {
      return leaf.closest('button, [role="button"], a') || leaf;
    }

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const b of buttons) {
      if (b.closest('#lenden-auto-hud')) continue;
      const text = (b.innerText || b.textContent || '').trim();
      if (/^Apply$/i.test(text) && b.offsetParent !== null) {
        return b;
      }
    }
    return null;
  }

  function findBackButton() {
    const titleLeaf = findLeafElementByText(/^(Repeat Loans|Filling Fast|Earn Daily|Earn Monthly)/i);
    if (titleLeaf) {
      let sib = titleLeaf.previousElementSibling;
      while (sib) {
        if (sib.matches('svg, button, a, [role="button"]') || sib.querySelector('svg, button, a')) {
          return sib.querySelector('svg, button, a') || sib;
        }
        sib = sib.previousElementSibling;
      }

      const header = titleLeaf.closest('header, [class*="header"], [class*="title"]') || titleLeaf.parentElement;
      if (header) {
        const btn = header.querySelector('button, a, svg, [role="button"], [class*="back"]');
        if (btn) return btn;
      }
    }

    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], svg'));
    for (const el of candidates) {
      if (el.closest('#lenden-auto-hud')) continue;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      if (aria.includes('back') || cls.includes('back') || cls.includes('arrow-left')) {
        return el.closest('button, a, [role="button"]') || el;
      }
    }

    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      if (el.closest('#lenden-auto-hud')) continue;
      const t = (el.innerText || el.textContent || '').trim();
      if (t === '←' || t === '<-' || t === '<') {
        return el;
      }
    }

    return null;
  }

  async function returnToMainPage(actionDelay) {
    if (isOnMainCategoriesPage()) {
      try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (e) {}
      return true;
    }

    logEvent('Returning to main categories page...', 'info');

    // 1. If on "Order Placed Successfully" screen, click "Lend More"
    const lendMoreBtn = findLeafElementByText(/^Lend\s+More$/i);
    if (lendMoreBtn) {
      logEvent('Found "Lend More" link on Order Success page. Clicking...', 'info');
      triggerRealClick(lendMoreBtn);
      await sleep(Math.max(2500, actionDelay));
      if (isOnMainCategoriesPage()) {
        try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (e) {}
        return true;
      }
    }

    // 2. Click back arrow (←) if present
    const backBtn = findBackButton();
    if (backBtn) {
      logEvent('Clicking back arrow (←)...', 'info');
      triggerRealClick(backBtn);
      await sleep(actionDelay);
      if (isOnMainCategoriesPage()) {
        try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (e) {}
        return true;
      }
    }

    // 3. Click "Live loans" top navigation link (directly opens /manual-lending)
    const liveLoansLink = Array.from(document.querySelectorAll('nav a, header a, a, button'))
      .find(el => /Live\s*loans/i.test((el.innerText || el.textContent || '').trim()));
    if (liveLoansLink) {
      logEvent('Clicking "Live loans" top navigation link...', 'info');
      triggerRealClick(liveLoansLink);
      await sleep(Math.max(2500, actionDelay));
      if (isOnMainCategoriesPage()) {
        try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (e) {}
        return true;
      }
    }

    // 4. Click "Dashboard" top navigation link
    const dashboardLink = Array.from(document.querySelectorAll('nav a, header a, a, button'))
      .find(el => /^Dashboard$/i.test((el.innerText || el.textContent || '').trim()));
    if (dashboardLink) {
      logEvent('Clicking "Dashboard" top navigation link...', 'info');
      triggerRealClick(dashboardLink);
      await sleep(Math.max(2500, actionDelay));
      if (isOnMainCategoriesPage()) {
        try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (e) {}
        return true;
      }
    }

    try {
      window.history.back();
    } catch (e) {}
    await sleep(actionDelay + 500);

    await waitFor(() => isOnMainCategoriesPage(), 6000);
    try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (e) {}
    return isOnMainCategoriesPage();
  }

  // -------------------------------------------------------------
  // PHASE 2: BORROWER LOAN REVIEW & BUREAU SCORE VERIFICATION
  // -------------------------------------------------------------

  // Locate all visible loan borrower cards
  function findLoanBorrowerCards() {
    const cards = [];

    // Find cards by identifying "Available to Fund"
    const leaves = Array.from(document.querySelectorAll('*')).filter(el => {
      if (el.closest('#lenden-auto-hud')) return false;
      const t = (el.innerText || el.textContent || '').trim();
      return /Available\s*to\s*Fund/i.test(t) && (!el.children || el.children.length === 0);
    });

    for (const leaf of leaves) {
      let card = leaf;
      let curr = leaf;
      for (let i = 0; i < 8; i++) {
        if (!curr.parentElement || curr.parentElement === document.body || curr.parentElement.id === 'root') break;
        const p = curr.parentElement;
        const t = p.innerText || '';
        if (/Available\s*to\s*Fund/i.test(t) && (/Loan\s*Approved/i.test(t) || /LenDenClub\s*Score/i.test(t))) {
          card = p;
          break;
        }
        curr = p;
      }

      if (card && !cards.some(c => c.card === card)) {
        const lines = (card.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        const name = lines[0]?.replace(/LenDenClub.*/i, '').trim() || 'Borrower';

        // "+ Add" button on the card
        const cardAddBtn = Array.from(card.querySelectorAll('button, [role="button"], a')).find(b => {
          return /\+?\s*Add/i.test((b.innerText || b.textContent || '').trim());
        });

        // Check if card already has "- Remove" (already added in current session)
        const isAlreadyAdded = Array.from(card.querySelectorAll('button, [role="button"], a, div')).some(b => {
          return /-\s*Remove/i.test((b.innerText || b.textContent || '').trim());
        });

        // Check for card-level Loan ID
        const cardText = card.innerText || '';
        const mId = cardText.match(/(?:Loan\s*(?:ID|#|No[:.]?))\s*[:#]?\s*([a-zA-Z0-9_-]+)/i);
        const cardLoanId = card.dataset?.loanId || card.dataset?.id || (mId ? mId[1] : null);

        cards.push({
          card: card,
          addBtn: cardAddBtn,
          name: name,
          loanId: cardLoanId,
          isAlreadyAdded: isAlreadyAdded
        });
      }
    }

    return cards;
  }

  // Extract all potential click targets on the borrower card to open "Borrower Details"
  function getBorrowerDetailsClickTargets(card) {
    if (!card) return [];
    const targets = [];
    const cardRect = card.getBoundingClientRect();
    const headerBottom = cardRect.top + Math.max(65, cardRect.height * 0.45);
    const rightHalf = cardRect.left + cardRect.width * 0.35;

    const allInside = Array.from(card.querySelectorAll('*')).filter(el => {
      if (el.closest('#lenden-auto-hud')) return false;
      // Do not click the "+ Add" button or "Available to Fund"
      if (el.closest('button, [role="button"]') && /\+?\s*Add/i.test(el.innerText || '')) return false;
      if (/Available\s*to\s*Fund/i.test(el.innerText || '')) return false;
      return true;
    });

    // 1. Look for explicit circular chevron / arrow button (Image 2)
    for (const el of allInside) {
      const text = (el.innerText || el.textContent || '').trim();
      const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const isChevronText = text === '>' || text === '›' || text === '→' || text === '»';
      const isChevronClass = cls.includes('chevron') || cls.includes('arrow') || cls.includes('right');
      const isIconTag = el.tagName === 'svg' || el.tagName === 'IMG' || el.tagName === 'I';

      const r = el.getBoundingClientRect();
      const inHeaderRight = r.top <= headerBottom && r.right >= rightHalf;

      if (inHeaderRight && (isChevronText || isChevronClass || isIconTag)) {
        if (r.width >= 6 && r.width <= 50 && r.height >= 6 && r.height <= 50) {
          targets.push({ el: el, desc: `Chevron/Icon (${el.tagName} "${text || cls}")`, priority: 1 });
          if (el.parentElement && el.parentElement !== card) {
            targets.push({ el: el.parentElement, desc: `Chevron Wrapper (${el.parentElement.tagName})`, priority: 2 });
          }
        }
      }
    }

    // 2. Look for any circular container in top-right (width/height 16-48px, round aspect ratio)
    for (const el of allInside) {
      const r = el.getBoundingClientRect();
      if (r.top <= headerBottom && r.right >= rightHalf) {
        if (r.width >= 16 && r.width <= 48 && r.height >= 16 && r.height <= 48 && Math.abs(r.width - r.height) <= 10) {
          if (!targets.some(t => t.el === el)) {
            targets.push({ el: el, desc: `Circular Button (${el.tagName} ${Math.round(r.width)}x${Math.round(r.height)})`, priority: 1 });
          }
        }
      }
    }

    // 3. Look for elements containing "LenDenClub Score"
    for (const el of allInside) {
      const t = (el.innerText || el.textContent || '').trim();
      if (/LenDenClub\s*Score/i.test(t)) {
        const r = el.getBoundingClientRect();
        if (r.width <= 320 && r.height <= 60) {
          if (!targets.some(t => t.el === el)) {
            targets.push({ el: el, desc: `Score Badge (${el.tagName}: "${t.slice(0, 30)}")`, priority: 3 });
          }
        }
      }
    }

    // 4. Look for the score number (e.g. 752, 790) in the top right
    for (const el of allInside) {
      const t = (el.innerText || el.textContent || '').trim();
      if (/^\d{3}$/.test(t)) {
        const r = el.getBoundingClientRect();
        if (r.top <= headerBottom && r.right >= rightHalf) {
          if (!targets.some(t => t.el === el)) {
            targets.push({ el: el, desc: `Score Number (${t})`, priority: 4 });
          }
        }
      }
    }

    // 5. Look for the Borrower Name element
    const nameLeaf = allInside.find(el => {
      const t = (el.innerText || el.textContent || '').trim();
      const r = el.getBoundingClientRect();
      return r.top <= headerBottom && r.left <= rightHalf &&
             t.length > 2 && t.length < 50 &&
             !/LenDenClub|Score|Loan|Fund|Interest|Tenure|Repayment/i.test(t) &&
             el.children.length === 0;
    });
    if (nameLeaf && !targets.some(t => t.el === nameLeaf)) {
      targets.push({ el: nameLeaf, desc: `Borrower Name (${nameLeaf.innerText.trim()})`, priority: 5 });
    }

    // 6. Header row container
    const scoreLeaf = allInside.find(el => /LenDenClub\s*Score/i.test(el.innerText || ''));
    if (scoreLeaf) {
      let curr = scoreLeaf.parentElement;
      while (curr && curr !== card && curr !== document.body) {
        const r = curr.getBoundingClientRect();
        if (r.height >= 24 && r.height <= 80 && r.width >= cardRect.width * 0.75) {
          if (!targets.some(t => t.el === curr)) {
            targets.push({ el: curr, desc: `Header Row (${curr.tagName})`, priority: 6 });
          }
          break;
        }
        curr = curr.parentElement;
      }
    }

    targets.sort((a, b) => a.priority - b.priority);
    return targets;
  }

  // Attempt to open Borrower Details by clicking valid targets
  async function openBorrowerDetails(card, borrowerName) {
    let modal = getOpenBorrowerDetailsModal();
    if (modal) return modal;

    const targets = getBorrowerDetailsClickTargets(card);
    if (!targets || targets.length === 0) {
      logEvent(`No click targets identified for "${borrowerName}".`, 'warn');
      return null;
    }

    for (const t of targets) {
      logEvent(`Clicking "${borrowerName}" ${t.desc}...`, 'info');
      triggerRealClick(t.el);

      modal = await waitFor(() => getOpenBorrowerDetailsModal(), 1200, 200);
      if (modal) {
        logEvent(`✓ Borrower Details opened for "${borrowerName}"!`, 'success');
        return modal;
      }
    }

    return null;
  }

  function getOpenBorrowerDetailsModal() {
    const titleLeaf = findLeafElementByText(/Borrower\s*Details/i);
    if (titleLeaf) {
      const r = titleLeaf.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return titleLeaf.closest('div[role="dialog"], [class*="modal"], [class*="dialog"], [class*="popup"], [class*="drawer"]') ||
               titleLeaf.parentElement?.parentElement?.parentElement ||
               titleLeaf.parentElement;
      }
    }

    const riskHeader = findLeafElementByText(/Risk\s*Category\s*(&|and)\s*Score/i);
    if (riskHeader) {
      const r = riskHeader.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return riskHeader.closest('div[role="dialog"], [class*="modal"], [class*="dialog"], [class*="popup"], [class*="drawer"]') ||
               riskHeader.parentElement?.parentElement?.parentElement ||
               riskHeader.parentElement;
      }
    }

    const loanDetails = findLeafElementByText(/Loan\s*Details/i);
    if (loanDetails) {
      const r = loanDetails.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return loanDetails.closest('div[role="dialog"], [class*="modal"], [class*="dialog"], [class*="popup"], [class*="drawer"]') ||
               loanDetails.parentElement?.parentElement?.parentElement ||
               loanDetails.parentElement;
      }
    }

    return null;
  }

  // Reliably close Borrower Details modal and wait for dismissal
  async function closeBorrowerModalAndWait(modalEl, timeoutMs = 3000) {
    if (!getOpenBorrowerDetailsModal()) return true;

    logEvent('Closing Borrower Details modal...', 'info');

    // 1. Try finding close button by geometry (top-right corner of modal, within 60px of top-right)
    const targetModal = modalEl || getOpenBorrowerDetailsModal();
    if (targetModal) {
      const modalRect = targetModal.getBoundingClientRect();
      const candidates = Array.from(targetModal.querySelectorAll('button, svg, [role="button"], span, div, i, a'));
      
      const cornerTargets = candidates.filter(el => {
        const r = el.getBoundingClientRect();
        return r.top <= modalRect.top + 70 &&
               r.right >= modalRect.right - 70 &&
               r.width >= 8 && r.width <= 60 &&
               r.height >= 8 && r.height <= 60;
      });

      for (const t of cornerTargets) {
        triggerRealClick(t);
        const closed = await waitFor(() => !getOpenBorrowerDetailsModal(), 700, 150);
        if (closed) return true;
      }
    }

    // 2. Try text / aria / class match for close buttons
    const all = Array.from(document.querySelectorAll('button, svg, [role="button"], span, div, a'));
    for (const el of all) {
      const text = (el.innerText || el.textContent || '').trim();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      if (text === '✕' || text === '×' || text === 'X' || aria.includes('close') || cls.includes('close')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          triggerRealClick(el);
          const closed = await waitFor(() => !getOpenBorrowerDetailsModal(), 700, 150);
          if (closed) return true;
        }
      }
    }

    // 3. Try Escape key
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    } catch (e) {}
    const escapeClosed = await waitFor(() => !getOpenBorrowerDetailsModal(), 700, 150);
    if (escapeClosed) return true;

    // 4. Try clicking backdrop overlay outside modal
    const backdrops = Array.from(document.querySelectorAll('[class*="backdrop"], [class*="overlay"], [class*="mask"]'));
    for (const b of backdrops) {
      triggerRealClick(b);
      const closed = await waitFor(() => !getOpenBorrowerDetailsModal(), 700, 150);
      if (closed) return true;
    }

    return !getOpenBorrowerDetailsModal();
  }

  // Scroll all internal containers of modal to reveal accordions
  function scrollModalToBottom(modalEl) {
    if (!modalEl) modalEl = document.body;
    const candidates = Array.from(modalEl.querySelectorAll('*'));
    for (const el of candidates) {
      if (el.scrollHeight > el.clientHeight + 15) {
        try {
          el.scrollTop = el.scrollHeight;
        } catch (e) {}
      }
    }
  }

  // Expand "Risk Category & Score" accordion (Image 5 & attached user image)
  async function expandRiskCategorySection(modalEl) {
    if (!modalEl) return false;

    // First: Check if "Bureau Score" is ALREADY visible
    let existingScore = extractBureauScore(modalEl);
    if (existingScore !== null) {
      return true;
    }

    // Scroll modal down so accordions are visible
    scrollModalToBottom(modalEl);
    await sleep(300);

    const riskTextEl = findLeafElementByText(/Risk\s*Category\s*(&|and)\s*Score/i, modalEl);
    if (!riskTextEl) {
      logEvent('Could not locate "Risk Category & Score" header in modal.', 'warn');
      return false;
    }

    // Scroll the header into view
    try {
      riskTextEl.scrollIntoView({ behavior: 'auto', block: 'center' });
    } catch (e) {}
    await sleep(300);

    // Identify the accordion header container (the light blue rounded bar in user's image)
    let headerBar = riskTextEl;
    let curr = riskTextEl.parentElement;
    while (curr && curr !== modalEl && curr !== document.body) {
      const r = curr.getBoundingClientRect();
      if (r.width > 160 && r.height >= 30 && r.height <= 95) {
        headerBar = curr;
        break;
      }
      curr = curr.parentElement;
    }

    // Collect all candidate click targets to expand the accordion:
    const expandTargets = [];
    const barRect = headerBar.getBoundingClientRect();

    // 1. All chevrons / icons inside headerBar (especially on the right side as shown in user's image)
    const iconsInBar = Array.from(headerBar.querySelectorAll('svg, i, img, [class*="chevron"], [class*="arrow"]'));
    for (const icon of iconsInBar) {
      if (!expandTargets.some(t => t.el === icon)) {
        expandTargets.push({ el: icon, desc: `Chevron/Icon in header (${icon.tagName})` });
        if (icon.parentElement && icon.parentElement !== headerBar) {
          expandTargets.push({ el: icon.parentElement, desc: `Chevron Wrapper (${icon.parentElement.tagName})` });
        }
      }
    }

    // 2. Elements on the far right side of headerBar
    const rightSideElements = Array.from(headerBar.querySelectorAll('*'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.right >= barRect.right - 80 && r.width >= 6 && r.width <= 60 && r.height >= 6 && r.height <= 60;
      });
    for (const el of rightSideElements) {
      if (!expandTargets.some(t => t.el === el)) {
        expandTargets.push({ el: el, desc: `Right Element (${el.tagName})` });
      }
    }

    // 2. The entire headerBar (the light blue box)
    if (headerBar && !expandTargets.some(t => t.el === headerBar)) {
      expandTargets.push({ el: headerBar, desc: `Header Bar (${headerBar.tagName})` });
    }

    // 3. Any button or role="button" inside or wrapping headerBar
    const btn = headerBar.closest('button, [role="button"]') || headerBar.querySelector('button, [role="button"]');
    if (btn && !expandTargets.some(t => t.el === btn)) {
      expandTargets.push({ el: btn, desc: `Accordion Button (${btn.tagName})` });
    }

    // 4. The text leaf and its immediate parent
    if (!expandTargets.some(t => t.el === riskTextEl)) {
      expandTargets.push({ el: riskTextEl, desc: 'Risk Text Leaf' });
    }
    if (riskTextEl.parentElement && !expandTargets.some(t => t.el === riskTextEl.parentElement)) {
      expandTargets.push({ el: riskTextEl.parentElement, desc: 'Risk Text Parent' });
    }

    // Try each target until "Bureau Score" appears!
    for (const target of expandTargets) {
      logEvent(`Expanding "Risk Category & Score" via ${target.desc}...`, 'info');
      triggerRealClick(target.el);

      const expanded = await waitFor(() => {
        return extractBureauScore(modalEl) !== null || findLeafElementByText(/Bureau\s*Score/i, modalEl);
      }, 1200, 200);

      if (expanded) {
        logEvent('✓ "Risk Category & Score" expanded successfully!', 'success');
        await sleep(400);
        return true;
      }
    }

    return extractBureauScore(modalEl) !== null;
  }

  function extractBureauScore(modalEl) {
    if (!modalEl) modalEl = getOpenBorrowerDetailsModal() || document.body;

    // 1. Direct regex match on modal text immediately following "Bureau Score"
    // Handles any numeric score (e.g. 11, -1, 0, 425, 750)
    // Uses [:\s\t\n]+ to ensure we only capture digits directly tied to Bureau Score
    const modalText = modalEl.innerText || modalEl.textContent || '';
    const directMatch = modalText.match(/Bureau\s*Score[:\s\t\n]+(-?\d+)/i);
    if (directMatch) {
      return parseInt(directMatch[1], 10);
    }

    // 2. Find leaf element strictly labelled "Bureau Score"
    const bureauLeaf = findLeafElementByText(/^Bureau\s*Score$/i, modalEl) ||
                       findLeafElementByText(/Bureau\s*Score/i, modalEl);

    if (bureauLeaf) {
      // Check 2A: Table cell adjacent to Bureau Score
      const tr = bureauLeaf.closest('tr, [role="row"]');
      if (tr) {
        const cells = Array.from(tr.querySelectorAll('td, th, [role="cell"]'));
        const idx = cells.findIndex(c => c.contains(bureauLeaf));
        if (idx !== -1 && idx + 1 < cells.length) {
          const valText = (cells[idx + 1].innerText || cells[idx + 1].textContent || '').trim();
          const m = valText.match(/^-?\d+/);
          if (m) return parseInt(m[0], 10);
        }
      }

      // Check 2B: Sibling element (e.g. <div class="label">Bureau Score</div><div class="value">11</div>)
      let sib = bureauLeaf.nextElementSibling;
      while (sib) {
        const t = (sib.innerText || sib.textContent || '').trim();
        const m = t.match(/^-?\d+/);
        if (m) return parseInt(m[0], 10);
        sib = sib.nextElementSibling;
      }

      // Check 2C: Immediate parent row ONLY (strictly avoid climbing into LenDenClub Score!)
      const parentRow = bureauLeaf.parentElement;
      if (parentRow && parentRow !== modalEl && parentRow !== document.body) {
        const rowText = (parentRow.innerText || parentRow.textContent || '').trim();
        if (!/LenDenClub/i.test(rowText) && !/Risk\s*Category/i.test(rowText)) {
          const textWithoutLabel = rowText.replace(/Bureau\s*Score[:\s\t\n]*/i, '').trim();
          const m = textWithoutLabel.match(/^-?\d+/);
          if (m) return parseInt(m[0], 10);
        }
      }
    }

    return null;
  }

  function findAddLoanButtonInModal(modalEl) {
    const openModal = modalEl || getOpenBorrowerDetailsModal();
    const scopes = [
      openModal,
      openModal?.parentElement,
      openModal?.closest('div[role="dialog"], [class*="modal"], [class*="dialog"], [class*="drawer"], [class*="popup"]'),
      document.body
    ].filter(Boolean);

    for (const scope of scopes) {
      // 1. Find leaf element with exact text "Add Loan"
      const leaf = findLeafElementByText(/^(\+\s*)?Add\s*Loan$/i, scope);
      if (leaf) {
        const btn = leaf.closest('button, [role="button"], a') || leaf.parentElement || leaf;
        const text = (btn.innerText || btn.textContent || '').trim();
        // Skip if button says "Add More Loans" (indicates loan already in cart)
        if (!/Add\s*More\s*Loans/i.test(text)) {
          const rect = btn.getBoundingClientRect();
          if (rect.width >= 40 && rect.height >= 25) {
            return btn;
          }
        }
      }

      // 2. Check all candidate elements with exact text "Add Loan"
      const candidates = Array.from(scope.querySelectorAll('button, [role="button"], a, div'));
      for (const el of candidates) {
        if (el.closest('#lenden-auto-hud')) continue;
        const text = (el.innerText || el.textContent || '').trim();
        if (/Add\s*More\s*Loans/i.test(text)) continue;
        if (/^(\+\s*)?Add\s*Loan$/i.test(text)) {
          const rect = el.getBoundingClientRect();
          if (rect.width >= 40 && rect.height >= 25 && rect.width <= 900 && rect.height <= 110) {
            return el.closest('button, [role="button"]') || el;
          }
        }
      }
    }

    // 3. Fallback: check anywhere in document for an element with exact text "Add Loan"
    const fallbackAll = Array.from(document.querySelectorAll('button, [role="button"], a, div'));
    for (const el of fallbackAll) {
      if (el.closest('#lenden-auto-hud')) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (/Add\s*More\s*Loans/i.test(text)) continue;
      if (/^(\+\s*)?Add\s*Loan$/i.test(text)) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 40 && rect.height >= 25 && rect.width <= 900 && rect.height <= 110) {
          return el.closest('button, [role="button"]') || el;
        }
      }
    }

    return null;
  }

  // List visible button labels (for diagnostics in the log)
  function describeVisibleButtons(limit = 8) {
    const labels = [];
    for (const b of Array.from(document.querySelectorAll('button, [role="button"]'))) {
      if (b.closest('#lenden-auto-hud')) continue;
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const t = (b.innerText || b.textContent || '').trim().replace(/\s+/g, ' ');
      if (t && t.length <= 40 && !labels.includes(t)) labels.push(t);
      if (labels.length >= limit) break;
    }
    return labels.join(' | ');
  }

  // Click "Add Loan" exactly once and verify the UI reacted
  async function clickAddLoanAndVerify(modal, borrowerName) {
    scrollModalToBottom(modal);
    await sleep(300);

    const addBtn = await waitFor(() => findAddLoanButtonInModal(modal), 3000, 250);
    if (!addBtn) {
      logEvent(`⚠ "Add Loan" button not found for "${borrowerName}". Visible buttons: ${describeVisibleButtons()}`, 'warn');
      return false;
    }

    const isDisabled = addBtn.disabled || addBtn.getAttribute('aria-disabled') === 'true';
    const r = addBtn.getBoundingClientRect();
    logEvent(`Found "Add Loan" (${addBtn.tagName}, ${Math.round(r.width)}x${Math.round(r.height)}${isDisabled ? ', DISABLED' : ''}).`, 'info');

    try { addBtn.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch (e) {}
    await sleep(300);

    const beforeText = (addBtn.innerText || addBtn.textContent || '').trim();

    const reacted = () => {
      if (!addBtn.isConnected) return 'button removed';
      const t = (addBtn.innerText || addBtn.textContent || '').trim();
      if (t !== beforeText) return `button changed to "${t}"`;
      if (!getOpenBorrowerDetailsModal()) return 'popup closed';
      return null;
    };

    logEvent(`Clicking "Add Loan" for "${borrowerName}"...`, 'info');
    triggerRealClick(addBtn);

    let result = await waitFor(reacted, 2500, 200);

    // Retry ONCE on the inner text label if the page showed no reaction at all
    if (!result) {
      const inner = findLeafElementByText(/^Add\s*Loan$/i, addBtn);
      if (inner && inner !== addBtn) {
        logEvent('No reaction yet. Retrying click on the "Add Loan" label...', 'info');
        triggerRealClick(inner);
        result = await waitFor(reacted, 2500, 200);
      }
    }

    if (result) {
      logEvent(`✓ "Add Loan" accepted for "${borrowerName}" (${result}).`, 'success');
      return true;
    }

    logEvent(`⚠ Clicked "Add Loan" but no change detected for "${borrowerName}". Visible buttons: ${describeVisibleButtons()}`, 'warn');
    return false;
  }

  // Scroll to load next batch of loan cards via infinite scroll or "Load More" button
  async function loadMoreLoansIfAvailable() {
    // 1. Check for explicit "Load More" / "View More" button
    const loadMoreBtn = findLeafElementByText(/Load\s*More|View\s*More|Show\s*More/i);
    if (loadMoreBtn) {
      const btn = loadMoreBtn.closest('button, [role="button"], a') || loadMoreBtn;
      try {
        btn.scrollIntoView({ behavior: 'auto', block: 'center' });
        await sleep(300);
        triggerRealClick(btn);
        await sleep(1500);
        return true;
      } catch (e) {}
    }

    // 2. Infinite scroll: scroll window and internal containers down to trigger data fetch
    try {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
    } catch (e) {}

    const scrollables = Array.from(document.querySelectorAll('*')).filter(el => {
      return el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200;
    });
    for (const s of scrollables) {
      try {
        s.scrollTop = s.scrollHeight;
      } catch (e) {}
    }

    await sleep(1500);
    return true;
  }

  // Extract unique loan identifier from card or popup modal
  function extractLoanIdentifier(card, modal) {
    if (card) {
      if (card.dataset && card.dataset.loanId) return card.dataset.loanId;
      if (card.dataset && card.dataset.id) return card.dataset.id;
      if (card.id && /loan/i.test(card.id)) return card.id;

      const link = Array.from(card.querySelectorAll('a[href]')).find(a => /(?:loan|borrower)[=_/]([a-zA-Z0-9_-]+)/i.test(a.href));
      if (link) {
        const m = link.href.match(/(?:loan|borrower)[=_/]([a-zA-Z0-9_-]+)/i);
        if (m) return m[1];
      }

      const cardText = card.innerText || '';
      const mCard = cardText.match(/(?:Loan\s*(?:ID|#|No[:.]?))\s*[:#]?\s*([a-zA-Z0-9_-]+)/i);
      if (mCard) return mCard[1];
    }

    if (modal) {
      if (modal.dataset && modal.dataset.loanId) return modal.dataset.loanId;
      const modalText = modal.innerText || '';
      const mModal = modalText.match(/(?:Loan\s*(?:ID|Application\s*ID|#|No[:.]?))\s*[:#]?\s*([a-zA-Z0-9_-]+)/i);
      if (mModal) return mModal[1];
    }

    return null;
  }

  // Review each borrower card, click the chevron/pill, check Bureau Score, and add if >= threshold
  async function reviewAndFilterLoans(categoryName, settings, actionDelay, remainingSelectLimit = null) {
    const minScore = parseInt(settings.minBureauScore ?? 700, 10);
    const maxLoans = parseInt(settings.maxLoansPerCategory ?? 50, 10);
    const configuredMaxSelect = Math.min(parseInt(settings.maxLoansToSelect ?? 50, 10), 300);
    const maxSelect = remainingSelectLimit !== null ? Math.min(remainingSelectLimit, configuredMaxSelect) : configuredMaxSelect;

    if (maxSelect <= 0) {
      logEvent(`Target selection limit already met. No more loans needed in "${categoryName}".`, 'info');
      return 0;
    }

    let borrowerCards = findLoanBorrowerCards();
    if (!borrowerCards || borrowerCards.length === 0) {
      logEvent(`No loan cards found in "${categoryName}".`, 'info');
      return 0;
    }

    // Load previously selected & inspected loans from persistent storage to prevent duplicate evaluation
    let savedSelectedLoans = [];
    try {
      const res = await chrome.storage.local.get(['savedSelectedLoans']);
      savedSelectedLoans = res.savedSelectedLoans || [];
    } catch (e) {}

    const savedNameMap = new Map();
    const savedIdMap = new Map();

    let acceptedCount = 0;
    let rejectedCount = 0;

    savedSelectedLoans.forEach(l => {
      const status = l.status || 'Accepted';
      if (status === 'Accepted') acceptedCount++;
      else rejectedCount++;

      const norm = (l.name || '').toLowerCase().replace(/^(mr|ms|mrs)\.?\s+/i, '').replace(/\s+/g, ' ').trim();
      if (norm) {
        savedNameMap.set(norm, l);
      }
      if (l.loanId) {
        savedIdMap.set(l.loanId.toLowerCase().trim(), l);
      }
    });

    if (savedSelectedLoans.length > 0) {
      logEvent(`Loaded ${savedSelectedLoans.length} previously inspected loan(s) (${acceptedCount} accepted, ${rejectedCount} rejected) - will be automatically skipped.`, 'info');
    }

    logEvent(`Starting loan evaluation in "${categoryName}" (Check up to: ${maxLoans}, Target selection: ${maxSelect}, Bureau Score: >= ${minScore})...`, 'info');

    let qualifiedCount = 0;
    let inspectedCount = 0;
    const processedBorrowerNames = new Set();

    while (inspectedCount < maxLoans && qualifiedCount < maxSelect) {
      if (stopRequested) throw new Error('Stopped by user');

      // Make sure NO modal is currently open before starting evaluation of a borrower
      const lingeringModal = getOpenBorrowerDetailsModal();
      if (lingeringModal) {
        logEvent('Lingering modal detected. Closing before next borrower...', 'info');
        await closeBorrowerModalAndWait(lingeringModal);
        await sleep(400);
      }

      // Re-query cards currently in DOM
      borrowerCards = findLoanBorrowerCards();

      // Find the next card that has not yet been inspected
      let nextCard = null;
      for (const c of borrowerCards) {
        if (!processedBorrowerNames.has(c.name)) {
          nextCard = c;
          break;
        }
      }

      // If no unprocessed cards in current DOM, scroll to fetch the next batch
      if (!nextCard) {
        logEvent(`Visible cards (${inspectedCount}) inspected. Loading next batch of loans...`, 'info');
        await loadMoreLoansIfAvailable();
        borrowerCards = findLoanBorrowerCards();

        for (const c of borrowerCards) {
          if (!processedBorrowerNames.has(c.name)) {
            nextCard = c;
            break;
          }
        }

        // If still no new cards appeared after scrolling, category has reached its end
        if (!nextCard) {
          logEvent(`No more additional loans found in "${categoryName}". Total inspected: ${inspectedCount}.`, 'info');
          break;
        }
      }

      const borrower = nextCard;
      processedBorrowerNames.add(borrower.name);

      // PRE-CHECK: Check if this borrower was already evaluated previously (Saved History) or in current batch
      const normBorrowerName = (borrower.name || '').toLowerCase().replace(/^(mr|ms|mrs)\.?\s+/i, '').replace(/\s+/g, ' ').trim();
      const savedRecord = (normBorrowerName && savedNameMap.get(normBorrowerName)) ||
                          (borrower.loanId && savedIdMap.get(borrower.loanId.toLowerCase().trim()));

      const isCardAlreadyAdded = borrower.isAlreadyAdded || Array.from(borrower.card.querySelectorAll('button, [role="button"], a, div')).some(b => {
        return /-\s*Remove/i.test((b.innerText || b.textContent || '').trim());
      });

      // A previously rejected loan whose saved score now meets the threshold (e.g. score == threshold,
      // or threshold was lowered) must be re-checked instead of skipped.
      const savedScoreNum = savedRecord ? parseInt(savedRecord.bureauScore, 10) : NaN;
      const shouldRecheckRejected = !!savedRecord && !isCardAlreadyAdded &&
        (savedRecord.status || 'Accepted') === 'Rejected' &&
        !isNaN(savedScoreNum) && savedScoreNum >= minScore;
      if (shouldRecheckRejected) {
        logEvent(`↻ Re-checking "${borrower.name}": previously rejected with Bureau Score ${savedScoreNum}, which now meets >= ${minScore}.`, 'info');
      }

      if ((savedRecord && !shouldRecheckRejected) || isCardAlreadyAdded) {
        let skipReason = '';
        if (savedRecord) {
          const st = savedRecord.status || 'Accepted';
          const rsn = savedRecord.reason || (savedRecord.bureauScore ? `Bureau Score ${savedRecord.bureauScore}` : '');
          skipReason = `Previously ${st}${rsn ? ` (${rsn})` : ''}`;
        } else {
          skipReason = 'Already added in current batch (- Remove)';
        }
        logEvent(`↷ Skipping "${borrower.name}": ${skipReason}.`, 'info');
        inspectedCount++;
        continue;
      }

      inspectedCount++;

      logEvent(`[${inspectedCount}/${maxLoans}] Checking "${borrower.name}" (Selected: ${qualifiedCount}/${maxSelect})...`, 'info');
      updateHudStep(`Checking ${borrower.name} (${inspectedCount}/${maxLoans} checked, ${qualifiedCount}/${maxSelect} selected)...`);

      // Scroll card into view
      try {
        borrower.card.scrollIntoView({ behavior: 'auto', block: 'center' });
      } catch (e) {}
      await sleep(350);

      // Open Borrower Details modal by clicking chevron / score pill
      const modal = await openBorrowerDetails(borrower.card, borrower.name);

      if (!modal) {
        logEvent(`Could not open Borrower Details for "${borrower.name}". Moving to next...`, 'warn');
        continue;
      }

      await sleep(500);

      // Expand "Risk Category & Score" (Image 5 & user image)
      const expanded = await expandRiskCategorySection(modal);
      await sleep(400);

      // Extract Bureau Score
      const bureauScore = extractBureauScore(modal);

      if (bureauScore !== null) {
        logEvent(`"${borrower.name}" → Bureau Score: ${bureauScore}`, 'info');

        if (bureauScore >= minScore) {
          logEvent(`✓ Qualified! Bureau Score ${bureauScore} >= ${minScore}. Adding loan...`, 'success');

          const added = await clickAddLoanAndVerify(modal, borrower.name);
          if (added) {
            qualifiedCount++;
            await sleep(1000);

            // Extract Loan ID and save to persistent history as Accepted
            const loanId = extractLoanIdentifier(borrower.card, modal) || `LDC-${Math.floor(100000 + Math.random() * 900000)}`;
            const record = {
              name: borrower.name,
              loanId: loanId,
              bureauScore: bureauScore,
              category: categoryName,
              status: 'Accepted',
              reason: `Bureau Score ${bureauScore} >= ${minScore}`,
              timestamp: Date.now()
            };
            chrome.runtime.sendMessage({
              action: 'SAVE_SELECTED_LOAN',
              loan: record
            }).catch(() => {});

            if (normBorrowerName) savedNameMap.set(normBorrowerName, record);
            if (loanId) savedIdMap.set(loanId.toLowerCase().trim(), record);

            // Check if user's max selection limit (or platform limit of 300) is reached
            if (qualifiedCount >= maxSelect) {
              logEvent(`★ Reached target selection limit (${qualifiedCount}/${maxSelect} loans added in "${categoryName}")! Proceeding to Continue...`, 'success');
              await closeBorrowerModalAndWait(modal);
              await sleep(800);
              break;
            }
          } else if (borrower.addBtn) {
            await closeBorrowerModalAndWait(modal);
            await sleep(400);
            triggerRealClick(borrower.addBtn);
            logEvent(`✓ Clicked "+ Add" on card for "${borrower.name}".`, 'success');
            qualifiedCount++;
            await sleep(800);

            const loanId = extractLoanIdentifier(borrower.card, modal) || `LDC-${Math.floor(100000 + Math.random() * 900000)}`;
            const record = {
              name: borrower.name,
              loanId: loanId,
              bureauScore: bureauScore,
              category: categoryName,
              status: 'Accepted',
              reason: `Bureau Score ${bureauScore} >= ${minScore}`,
              timestamp: Date.now()
            };
            chrome.runtime.sendMessage({
              action: 'SAVE_SELECTED_LOAN',
              loan: record
            }).catch(() => {});

            if (normBorrowerName) savedNameMap.set(normBorrowerName, record);
            if (loanId) savedIdMap.set(loanId.toLowerCase().trim(), record);

            if (qualifiedCount >= maxSelect) {
              logEvent(`★ Reached target selection limit (${qualifiedCount}/${maxSelect} loans added in "${categoryName}")! Proceeding to Continue...`, 'success');
              await sleep(800);
              break;
            }
          }
        } else {
          // Disqualified loan - save as Rejected so it's not checked again in future runs!
          const loanId = extractLoanIdentifier(borrower.card, modal) || `LDC-${Math.floor(100000 + Math.random() * 900000)}`;
          const reason = `Bureau Score ${bureauScore} < ${minScore}`;
          logEvent(`✕ Skipped: ${reason} for "${borrower.name}". (Saved to rejected history)`, 'info');

          const record = {
            name: borrower.name,
            loanId: loanId,
            bureauScore: bureauScore,
            category: categoryName,
            status: 'Rejected',
            reason: reason,
            timestamp: Date.now()
          };
          chrome.runtime.sendMessage({
            action: 'SAVE_SELECTED_LOAN',
            loan: record
          }).catch(() => {});

          if (normBorrowerName) savedNameMap.set(normBorrowerName, record);
          if (loanId) savedIdMap.set(loanId.toLowerCase().trim(), record);
        }
      } else {
        // Bureau score not visible - save as Rejected
        const loanId = extractLoanIdentifier(borrower.card, modal) || `LDC-${Math.floor(100000 + Math.random() * 900000)}`;
        logEvent(`⚠ Bureau Score not visible for "${borrower.name}". Skipping. (Saved to rejected history)`, 'warn');

        const record = {
          name: borrower.name,
          loanId: loanId,
          bureauScore: 'N/A',
          category: categoryName,
          status: 'Rejected',
          reason: 'Bureau Score not visible',
          timestamp: Date.now()
        };
        chrome.runtime.sendMessage({
          action: 'SAVE_SELECTED_LOAN',
          loan: record
        }).catch(() => {});

        if (normBorrowerName) savedNameMap.set(normBorrowerName, record);
        if (loanId) savedIdMap.set(loanId.toLowerCase().trim(), record);
      }

      // ALWAYS close the modal and wait for it to disappear before next iteration!
      await closeBorrowerModalAndWait(modal);
      await sleep(500);
    }

    logEvent(`✓ Finished review for "${categoryName}". Inspected ${inspectedCount} loan(s), added ${qualifiedCount}/${maxSelect} with Bureau Score >= ${minScore}.`, 'success');
    return qualifiedCount;
  }

  // -------------------------------------------------------------
  // CONTINUE BUTTON HANDLER (LENDING SUMMARY CHECKOUT)
  // -------------------------------------------------------------

  function findContinueButton() {
    const continueRegex = /^\s*Continue(?:\s*[>→›])?\s*$/i;

    // 1. Look for leaf element with regex matching "Continue"
    const leaf = findLeafElementByText(continueRegex);
    if (leaf) {
      const btn = leaf.closest('button, [role="button"], a') || leaf.parentElement || leaf;
      const r = btn.getBoundingClientRect();
      if (r.width >= 40 && r.height >= 25) {
        return btn;
      }
    }

    // 2. Check all buttons or role="button" elements
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div'));
    for (const el of candidates) {
      if (el.closest('#lenden-auto-hud')) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (continueRegex.test(text)) {
        const r = el.getBoundingClientRect();
        if (r.width >= 40 && r.height >= 25 && r.width <= 750 && r.height <= 90) {
          return el.closest('button, [role="button"]') || el;
        }
      }
    }

    return null;
  }

  async function clickContinueIfAvailable(categoryName, actionDelay, addedCount = 0) {
    // Check if any loans are selected or were added
    const hasSelectedLoans = addedCount > 0 ||
      /(\d+)\s+out\s+of\s+300\s+loans\s+selected/i.test(document.body.innerText) ||
      document.body.innerText.includes('Total Selected Borrowers') ||
      findLeafElementByText(/- Remove/i) !== null;

    if (!hasSelectedLoans) {
      logEvent(`No loans selected to continue in "${categoryName}".`, 'info');
      return false;
    }

    logEvent(`Checking for "Continue" button in "${categoryName}"...`, 'info');

    // First: Ensure any modal is completely closed before clicking Continue
    const openModal = getOpenBorrowerDetailsModal();
    if (openModal) {
      await closeBorrowerModalAndWait(openModal);
      await sleep(600);
    }

    // Wait up to 10 seconds for the Continue button to appear AND become enabled
    // (LenDenClub disables it for 1-2s while updating cart totals / processing the last added loan)
    const continueBtn = await waitFor(() => {
      const btn = findContinueButton();
      if (!btn) return null;
      const isDisabled = btn.disabled ||
                         btn.getAttribute('aria-disabled') === 'true' ||
                         btn.classList.contains('disabled');
      // If button is found and enabled, return it!
      if (!isDisabled) return btn;
      return null;
    }, 10000, 400);

    let targetBtn = continueBtn;
    if (!targetBtn) {
      // Check if button is in DOM but stayed marked disabled
      const fallbackBtn = findContinueButton();
      if (fallbackBtn) {
        logEvent(`"Continue" button remained disabled in "${categoryName}". Attempting fallback click...`, 'warn');
        try {
          fallbackBtn.removeAttribute('disabled');
          fallbackBtn.removeAttribute('aria-disabled');
          fallbackBtn.classList.remove('disabled');
        } catch (e) {}
        targetBtn = fallbackBtn;
      }
    }

    if (!targetBtn) {
      logEvent(`"Continue" button not found in "${categoryName}".`, 'warn');
      return false;
    }

    try {
      targetBtn.scrollIntoView({ behavior: 'auto', block: 'center' });
    } catch (e) {}
    await sleep(500);

    logEvent(`Clicking "Continue" button for "${categoryName}"...`, 'info');
    triggerRealClick(targetBtn);
    logEvent(`✓ Clicked "Continue" for "${categoryName}"!`, 'success');
    await sleep(Math.max(2500, actionDelay));

    // Wait for "Order Placed Successfully" or "Lend More"
    const orderSuccess = await waitFor(() => {
      return findLeafElementByText(/Order\s+Placed\s+Successfully/i) ||
             findLeafElementByText(/^Lend\s+More$/i);
    }, 8000, 400);

    if (orderSuccess) {
      logEvent(`★ Order placed successfully for "${categoryName}"!`, 'success');
      await sleep(1500);
    }

    return true;
  }

  // -------------------------------------------------------------
  // AUTOMATION WORKFLOW ORCHESTRATION
  // -------------------------------------------------------------

  async function startAutomationCycle(settings) {
    isCycleRunning = true;
    const actionDelay = Math.max(1200, parseInt(settings.actionDelayMs || 1800, 10));

    initHud(settings);
    updateHudStatus('running', 'Starting cycle...');
    logEvent('▶ Starting LenDenClub automation cycle...', 'info');

    try {
      if (!isOnMainCategoriesPage()) {
        await returnToMainPage(actionDelay);
      }

      // 1. Resolve user categories strictly from settings checkboxes
      const userSelected = (settings.categories && settings.categories.length > 0)
        ? settings.categories
        : ['Repeat Loans', 'Filling Fast', 'Earn Monthly'];

      // Strictly skip "Earn Daily"
      let targetCategories = userSelected.filter(c => !/Earn\s*Daily/i.test(c));

      // 2. If auto-detect is enabled, ONLY verify presence among the user's selected categories
      // NEVER add categories that the user unchecked!
      if (settings.autoDetectCategories) {
        const detected = detectAvailableCategories();
        if (detected.length > 0) {
          const verified = targetCategories.filter(c =>
            detected.some(d => d.toLowerCase().trim() === c.toLowerCase().trim())
          );
          if (verified.length > 0) {
            targetCategories = verified;
          }
        }
      }

      logEvent(`Categories to process (${targetCategories.length}): ${targetCategories.join(', ')}`, 'info');

      const maxTargetSelect = Math.min(parseInt(settings.maxLoansToSelect ?? 50, 10), 300);
      let totalSelectedInCycle = 0;
      let processedCount = 0;

      for (let i = 0; i < targetCategories.length; i++) {
        if (stopRequested) throw new Error('Stopped by user');

        const catName = targetCategories[i];
        const isLastCategory = (i === targetCategories.length - 1);

        logEvent(`[${i + 1}/${targetCategories.length}] Opening category: "${catName}" (Target: up to ${maxTargetSelect} loan(s))...`, 'info');
        updateHudStatus('running', `Category: ${catName} [${i + 1}/${targetCategories.length}]`);

        if (!isOnMainCategoriesPage()) {
          await returnToMainPage(actionDelay);
          await sleep(actionDelay);
        }

        const catResult = await processCategory(catName, settings, actionDelay, maxTargetSelect);
        if (catResult && catResult.success) {
          processedCount++;
          const addedInCat = catResult.addedCount || 0;
          totalSelectedInCycle += addedInCat;
          logEvent(`✓ Completed "${catName}". Added ${addedInCat} loan(s). Total across categories: ${totalSelectedInCycle}`, 'success');

          // If there are more categories to process, return to main page now
          if (!isLastCategory) {
            logEvent(`Proceeding to next category [${i + 2}/${targetCategories.length}]: "${targetCategories[i + 1]}"...`, 'info');
            await returnToMainPage(actionDelay);
            await sleep(actionDelay);
          }
        } else {
          logEvent(`⚠ Skipping "${catName}" - returning to main page`, 'warn');
          if (!isOnMainCategoriesPage()) {
            await returnToMainPage(actionDelay);
            await sleep(actionDelay);
          }
        }
      }

      const summaryMsg = `Cycle completed! Selected ${totalSelectedInCycle} loan(s) across ${processedCount} category(s).`;
      logEvent(`★ ${summaryMsg}`, totalSelectedInCycle > 0 ? 'success' : 'info');
      updateHudStatus(totalSelectedInCycle > 0 ? 'idle' : 'warn', summaryMsg);

      chrome.runtime.sendMessage({
        action: 'CYCLE_COMPLETED',
        success: true,
        message: summaryMsg
      }).catch(() => {});

    } catch (err) {
      const errMsg = err.message || 'Unknown error occurred';
      logEvent(`✖ Cycle stopped: ${errMsg}`, 'error');
      updateHudStatus('error', errMsg);

      // Only notify background if stopped due to an actual error, not when manually stopped by user
      if (errMsg !== 'Stopped by user' && errMsg !== 'Automation stopped') {
        chrome.runtime.sendMessage({
          action: 'CYCLE_COMPLETED',
          success: false,
          message: errMsg
        }).catch(() => {});
      }
    } finally {
      isCycleRunning = false;
      stopRequested = false;
    }
  }

  // -------------------------------------------------------------
  // CHOOSE LENDING AMOUNT HANDLER (SELECT MINIMUM ₹250)
  // -------------------------------------------------------------

  function getVisibleText(el) {
    return ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  }

  function parseRupees(str) {
    const n = parseInt(String(str || '').replace(/[^\d]/g, ''), 10);
    return isNaN(n) ? null : n;
  }

  // Finds the "Choose Lending Amount" card (the panel containing the slider + ₹250/₹2,000/₹4,000 presets)
  function findLendingAmountPanel() {
    const anchor = findLeafElementByText(/I\s*want\s*to\s*lend\s*up\s*to/i) ||
                   findLeafElementByText(/^Choose\s+Lending\s+Amount$/i);
    if (!anchor) return null;

    let cur = anchor;
    for (let i = 0; i < 10 && cur && cur !== document.body; i++) {
      const t = getVisibleText(cur);
      if (/per\s*loan/i.test(t) && /250/.test(t) && /(2,?000|4,?000)/.test(t)) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  // Reads the currently selected amount from "I want to lend up to ₹X per loan". Returns a number or null.
  function getCurrentLendingAmount() {
    const panel = findLendingAmountPanel();
    const scope = panel || document.body;

    // a) Strict element: "₹1,000 per loan" / "₹250 per loan"
    const els = Array.from(scope.querySelectorAll('*'));
    for (const el of els) {
      if (el.closest('#lenden-auto-hud')) continue;
      const t = getVisibleText(el);
      if (t.length > 40) continue;
      const m = t.match(/^[₹\u20B9]?\s*([\d,]+)\s*per\s*loan$/i);
      if (m) return parseRupees(m[1]);
    }

    // b) Fallback: "I want to lend up to ₹X per loan" (amount must be IMMEDIATELY followed by "per loan")
    const t = getVisibleText(scope);
    const m = t.match(/lend\s*up\s*to\s*[₹\u20B9]?\s*([\d,]+)\s*per\s*loan/i);
    if (m) return parseRupees(m[1]);

    return null;
  }

  function isMinimumAmountAlreadySelected() {
    return getCurrentLendingAmount() === 250;
  }

  // Finds the "₹250" PRESET button (not the "Minimum ₹250" slider label)
  function findMinimumAmount250Button() {
    const panel = findLendingAmountPanel();
    if (!panel) return null;

    const candidates = [];
    const all = Array.from(panel.querySelectorAll('*'));
    for (const el of all) {
      if (el.closest('#lenden-auto-hud')) continue;
      const clean = getVisibleText(el).replace(/[₹\u20B9\s,]/g, '');
      if (clean !== '250') continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) continue;

      // Exclude the slider's "Minimum / ₹250" tick label
      const parentText = getVisibleText(el.parentElement);
      const prevText = getVisibleText(el.previousElementSibling);
      if (/^Minimum$/i.test(prevText) || /^Minimum\s*[₹\u20B9]?\s*250$/i.test(parentText)) continue;

      candidates.push({ el, rect });
    }

    if (candidates.length === 0) return null;

    // Prefer real buttons, then the lowest element on screen (presets sit below the slider labels),
    // then the largest box (the button wrapper rather than the inner text span)
    candidates.sort((a, b) => {
      const aBtn = !!a.el.closest('button, [role="button"]');
      const bBtn = !!b.el.closest('button, [role="button"]');
      if (aBtn !== bBtn) return aBtn ? -1 : 1;
      if (Math.abs(b.rect.top - a.rect.top) > 4) return b.rect.top - a.rect.top;
      return (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height);
    });

    const chosen = candidates[0].el;
    return chosen.closest('button, [role="button"]') || chosen;
  }

  // Build a list of click targets: the button, its inner text node holder, and its parents (some React
  // components attach onClick to a wrapper rather than the element containing the text)
  function getAmountButtonClickTargets(btn) {
    const targets = [];
    const push = (el) => { if (el && !targets.includes(el) && el !== document.body) targets.push(el); };
    push(btn);
    const inner = Array.from(btn.querySelectorAll('*')).find(c => getVisibleText(c).replace(/[₹\u20B9\s,]/g, '') === '250');
    push(inner);
    push(btn.parentElement);
    return targets;
  }

  async function selectMinimumLendingAmount(categoryName, settings, actionDelay) {
    logEvent(`Checking for "Choose Lending Amount" (₹250 minimum) in "${categoryName}"...`, 'info');

    if (settings && settings.selectMinAmount === false) {
      logEvent('"Select Min Amount (₹250)" is turned OFF in Options. Skipping.', 'info');
      return false;
    }

    // Wait up to 5s for the lending amount panel to mount
    const panel = await waitFor(() => findLendingAmountPanel(), 5000, 300);
    if (!panel) {
      logEvent(`"Choose Lending Amount" panel not present in "${categoryName}"; proceeding with existing amount.`, 'info');
      return false;
    }

    const before = getCurrentLendingAmount();
    if (before === 250) {
      logEvent(`ℹ Lending amount is already ₹250 per loan in "${categoryName}".`, 'info');
      return true;
    }

    const btn250 = await waitFor(() => findMinimumAmount250Button(), 3000, 300);
    if (!btn250) {
      logEvent(`"₹250" preset button not found in "${categoryName}" (current: ₹${before ?? '?'} per loan). Proceeding.`, 'warn');
      return false;
    }

    logEvent(`Current amount ₹${before ?? '?'} per loan. Clicking "₹250" preset (${btn250.tagName}) in "${categoryName}"...`, 'info');

    const targets = getAmountButtonClickTargets(btn250);
    for (let i = 0; i < targets.length; i++) {
      triggerRealClick(targets[i]);
      const ok = await waitFor(() => isMinimumAmountAlreadySelected(), 1500, 250);
      if (ok) {
        logEvent(`✓ Lending amount set to ₹250 per loan in "${categoryName}".`, 'success');
        await sleep(Math.min(800, actionDelay / 2));
        return true;
      }
    }

    // Last resort: a native range input, if the slider uses one
    try {
      const sliderInput = panel.querySelector('input[type="range"]');
      if (sliderInput) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(sliderInput, String(sliderInput.min || 250));
        sliderInput.dispatchEvent(new Event('input', { bubbles: true }));
        sliderInput.dispatchEvent(new Event('change', { bubbles: true }));
        if (await waitFor(() => isMinimumAmountAlreadySelected(), 1500, 250)) {
          logEvent(`✓ Lending amount set to ₹250 per loan via slider in "${categoryName}".`, 'success');
          return true;
        }
      }
    } catch (e) {}

    logEvent(`⚠ Could not confirm ₹250 selection in "${categoryName}" (still shows ₹${getCurrentLendingAmount() ?? '?'} per loan). Proceeding.`, 'warn');
    return false;
  }

  async function processCategory(categoryName, settings, actionDelay, remainingSelectLimit = 50) {
    // 1. Get click targets for this category (scoped strictly to Trending Container)
    const targets = await waitFor(() => {
      const list = getCategoryClickTargets(categoryName);
      return list.length > 0 ? list : null;
    }, 6000);

    if (!targets || targets.length === 0) {
      logEvent(`Could not find elements for "${categoryName}".`, 'warn');
      return { success: false, addedCount: 0, reachedTargetLimit: false };
    }

    logEvent(`Opening "${categoryName}" (${targets.length} targets found)...`, 'info');

    // Click targets (Circle Icon first!) until Filter & Sort appears
    let filterSortBtn = null;
    for (const t of targets) {
      logEvent(`Clicking: ${t.desc}...`, 'info');
      triggerRealClick(t.el);

      filterSortBtn = await waitFor(() => findFilterSortButton(), 3500, 300);
      if (filterSortBtn) {
        break;
      }
    }

    // 2. Wait for loans view and "Filter & Sort" button if not already found
    if (!filterSortBtn) {
      logEvent('Waiting for "Filter & Sort" button...', 'info');
      filterSortBtn = await waitFor(() => findFilterSortButton(), 6000);
      if (!filterSortBtn) {
        logEvent(`"Filter & Sort" button not found after clicking "${categoryName}".`, 'warn');
        return { success: false, addedCount: 0, reachedTargetLimit: false };
      }
    }

    // 2.5. Select Minimum Lending Amount (₹250) if present in this category before applying filters
    await selectMinimumLendingAmount(categoryName, settings, actionDelay);

    // 3. Click "Filter & Sort"
    logEvent(`Clicking "Filter & Sort" button...`, 'info');
    triggerRealClick(filterSortBtn);
    await sleep(actionDelay);

    // 4. Wait for modal to open
    const modalReady = await waitFor(() => isFilterModalOpen() || findApplyButton(), 8000);
    if (!modalReady) {
      logEvent('Filter & Sort modal did not open in time.', 'warn');
      return { success: false, addedCount: 0, reachedTargetLimit: false };
    }

    // 5. Look for "Click to load" (Re-load filters & sort)
    logEvent('Checking for "Click to load" (saved filters & sort)...', 'info');
    const reloadBtn = findReloadFiltersButton();

    if (reloadBtn) {
      logEvent('Found "Click to load" button! Clicking to re-load last used filters...', 'info');
      triggerRealClick(reloadBtn);
      await sleep(1500);
      logEvent('Last used filters & sort reloaded.', 'success');
    } else if (isFiltersAlreadyLoaded()) {
      logEvent('Last used filters & sort already loaded ("Last used filters loaded").', 'info');
    } else {
      logEvent('"Click to load" prompt not detected; proceeding with existing filter state.', 'info');
    }

    await sleep(600);

    // 6. Click "Apply" button
    const applyBtn = await waitFor(() => findApplyButton(), 6000);
    if (!applyBtn) {
      logEvent('"Apply" button not found inside Filter & Sort modal.', 'error');
      return { success: false, addedCount: 0, reachedTargetLimit: false };
    }

    logEvent('Clicking "Apply" button...', 'info');
    triggerRealClick(applyBtn);

    // 7. Explicit 3-second wait as requested for loans to load
    logEvent(`Filters applied for "${categoryName}". Waiting 3 seconds for loans to load...`, 'info');
    await sleep(3000);

    // 7.5 Re-verify ₹250 (applying saved filters can reset the lending amount on some categories)
    if (!(settings && settings.selectMinAmount === false) && findLendingAmountPanel()) {
      const amt = getCurrentLendingAmount();
      if (amt !== null && amt !== 250) {
        logEvent(`Lending amount changed to ₹${amt} after applying filters. Re-selecting ₹250...`, 'warn');
        await selectMinimumLendingAmount(categoryName, settings, actionDelay);
      }
    }

    // 8. Wait for either loan cards OR "No loans match your filters"
    const result = await waitFor(() => {
      if (findLeafElementByText(/No\s+loans\s+match\s+your\s+filters/i)) {
        return 'EMPTY';
      }
      const cards = findLoanBorrowerCards();
      if (cards && cards.length > 0) {
        return cards;
      }
      return null;
    }, 8000);

    if (result === 'EMPTY') {
      logEvent(`ℹ No loans match filters for "${categoryName}". Returning to main page...`, 'info');
      await returnToMainPage(actionDelay);
      await sleep(actionDelay);
      return { success: true, addedCount: 0 };
    } else if (result && result.length > 0) {
      // 9. PHASE 2: Evaluate borrower cards and auto-add if Bureau Score > 700!
      const addedCount = await reviewAndFilterLoans(categoryName, settings || {}, actionDelay, remainingSelectLimit);

      // Check and click "Continue" button if loans were added
      let continued = false;
      if (addedCount > 0) {
        continued = await clickContinueIfAvailable(categoryName, actionDelay, addedCount);
        logEvent(`★ Category "${categoryName}" completed! Added ${addedCount} loan(s) and placed order.`, 'success');
      } else {
        logEvent(`ℹ No qualified loans added in "${categoryName}". Returning to main page...`, 'info');
        await returnToMainPage(actionDelay);
        await sleep(actionDelay);
      }

      return { success: true, addedCount, continued };
    } else {
      logEvent(`ℹ No loan cards rendered for "${categoryName}".`, 'info');
      await returnToMainPage(actionDelay);
      await sleep(actionDelay);
      return { success: false, addedCount: 0 };
    }
  }

  // -------------------------------------------------------------
  // FLOATING ON-PAGE HUD / STATUS BADGE
  // -------------------------------------------------------------

  function initHud(settings) {
    if (settings && settings.showFloatingHud === false) {
      if (hudElement) hudElement.remove();
      return;
    }

    if (document.getElementById('lenden-auto-hud')) {
      return;
    }

    hudElement = document.createElement('div');
    hudElement.id = 'lenden-auto-hud';
    hudElement.innerHTML = `
      <div id="ld-hud-min" class="ld-hud-minimized">
        <div id="ld-dot" class="ld-hud-dot idle"></div>
        <span>LenDenClub Auto-Filter</span>
      </div>
      <div id="ld-hud-card" class="ld-hud-card" style="display: none;">
        <div class="ld-hud-header">
          <div class="ld-hud-title">
            <span>⚡ LenDenClub Automator</span>
          </div>
          <div class="ld-hud-controls">
            <button id="ld-btn-minimize" class="ld-hud-btn-icon" title="Minimize">−</button>
          </div>
        </div>
        <div class="ld-hud-body">
          <div class="ld-hud-status-row">
            <div id="ld-status-badge" class="ld-hud-status-badge ld-status-idle">IDLE</div>
            <div id="ld-timer" class="ld-hud-timer">Every 31st Min</div>
          </div>
          <div id="ld-step" class="ld-hud-step">Ready and scheduled.</div>
          <div class="ld-hud-actions">
            <button id="ld-run-now" class="ld-btn ld-btn-primary">▶ Run Now</button>
            <button id="ld-stop" class="ld-btn ld-btn-danger">⏹ Stop</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(hudElement);

    const minView = document.getElementById('ld-hud-min');
    const cardView = document.getElementById('ld-hud-card');
    const btnMin = document.getElementById('ld-btn-minimize');
    const btnRun = document.getElementById('ld-run-now');
    const btnStop = document.getElementById('ld-stop');

    minView.addEventListener('click', () => {
      minView.style.display = 'none';
      cardView.style.display = 'flex';
      hudMinimized = false;
    });

    btnMin.addEventListener('click', () => {
      cardView.style.display = 'none';
      minView.style.display = 'flex';
      hudMinimized = true;
    });

    btnRun.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'RUN_MANUAL' });
    });

    btnStop.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'STOP_CYCLE' });
    });
  }

  function updateHudStatus(status, text) {
    const dot = document.getElementById('ld-dot');
    const badge = document.getElementById('ld-status-badge');
    if (!badge || !dot) return;

    dot.className = `ld-hud-dot ${status}`;
    badge.className = `ld-hud-status-badge ld-status-${status}`;
    badge.textContent = status.toUpperCase();

    const step = document.getElementById('ld-step');
    if (step && text) {
      step.textContent = text;
    }
  }

  function updateHudStep(message) {
    const step = document.getElementById('ld-step');
    if (step) {
      step.textContent = message;
    }
  }

  chrome.storage.local.get(['settings'], (res) => {
    const s = res.settings || { showFloatingHud: true };
    if (s.showFloatingHud !== false) {
      initHud(s);
    }
  });

})();
