# LenDenClub Auto-Filter & Smart Loan Picker - Chrome Extension

A Google Chrome Extension (Manifest V3) designed to automatically navigate LenDenClub categories, re-load your saved filters & sort, inspect borrower details, and add loans where the **Bureau Score > 700** on a schedule (every 31st minute or every 31 minutes)—**even when the browser tab is running in the background or unfocused**.

---

## 🎯 What This Extension Automates

### Phase 1: Category & Filter Automation
1. **Main Page / Dashboard (`https://app.lendenclub.com/dashboard`)**:
   - Detects the **"Trending category"** section.
2. **Category Selection**:
   - Sequentially opens:
     - 🪙 **Repeat Loans**
     - ⏱ **Filling Fast**
     - 🗓 **Earn Monthly**
     *(Earn Daily is skipped by default as requested)*
3. **Filter & Sort Application**:
   - Clicks **"Filter & Sort"** (funnel icon).
   - Re-loads your saved filters by clicking **"Click to load"**.
   - Clicks the **"Apply"** button.

### Phase 2: Borrower Bureau Score Check & Auto-Add
4. **Loan Evaluation**:
   - If "No loans match your filters" is displayed, it returns to the main page and proceeds to the next category.
   - If loans are found, it reviews each borrower card one-by-one:
     1. Clicks the `LenDenClub Score: [XXX] >` chevron to open **"Borrower Details"** popup.
     2. Scrolls down to the **"Risk Category & Score"** section.
     3. Expands the accordion if needed and reads the **Bureau Score**.
     4. **Condition Check**:
        - **If Bureau Score > 700**: Clicks **"Add Loan"** / **"+ Add"** inside the popup, logs the success, and closes the modal.
        - **If Bureau Score <= 700** (e.g. 425): Skips the borrower and closes the modal immediately.
5. **Multi-Category Cycling**:
   - Clicks the back arrow (`←`) or "Dashboard" link to return to the main categories list.
   - Repeats the exact same process for the next category!

---

## 🚀 How to Install / Reload in Google Chrome

1. Open Google Chrome and visit:
   ```
   chrome://extensions
   ```
2. Turn **ON** **Developer mode** (top-right corner).
3. If not yet loaded, click **"Load unpacked"** and select:
   ```
   /Users/ashwing/Documents/lenden_crom_extention
   ```
   *(If already loaded, simply click the 🔄 **Reload** button on the extension card)*.
4. Open or refresh your LenDenClub page:
   [https://app.lendenclub.com/dashboard](https://app.lendenclub.com/dashboard)
5. Click the **LenDenClub** extension icon in your Chrome toolbar:
   - Click **"▶ Run Now"** to test immediately.
   - Under the **"Options"** tab, you can customize the Minimum Bureau Score (default: `700`) and the maximum loans to inspect per category.

---

## ⚙️ Features & Settings

- **Schedule Mode**:
  - **Hourly at specific minute**: Default is **31** (runs at minute :31 of every hour: 10:31, 11:31, 12:31...).
  - **Fixed interval**: Repeatedly runs every **31** minutes.
- **Bureau Score Threshold**: Configurable minimum score (default: `700`).
- **Auto-Add**: Toggles whether qualified loans are automatically added to your investment cart.
- **Activity Stream / Logs**: Live timestamped console showing every category opened, modal inspected, Bureau Score read, and loan added.
