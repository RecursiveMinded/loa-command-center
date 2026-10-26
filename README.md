# LOA Command Center

A Windows desktop app for managing Letters of Approval (LOAs) and payment terminal certifications: EMV L1/L2, card brand approvals, TQM and PCI PTS.

Drop your LOAs in. The app reads them (including scans), splits merged PDFs into letters, matches each letter to your devices, and proposes the updates. You approve. A built-in planner then tells you what to renew, chase or clean up, and when, and sends a daily, weekly or monthly reminder.

Everything runs on your computer. No LOA, record or report is uploaded anywhere.

## What it does

| Area | Details |
| --- | --- |
| **LOA inbox** | Bulk drag and drop of files or whole folders. PDF text is read with pdf.js; scanned pages and images (PNG/JPG/TIFF) are read by an offline OCR engine (Tesseract). Merged PDFs are split into letters. Duplicates are detected by file hash. |
| **Letter reader** | Layouts for Amex, Discover, EMVCo, Interac, JCB, Mastercard (L2 and TQM), PCI PTS, UnionPay, Visa and eftpos, plus a general fallback. Pulls the device(s), approval number, issue date, expiry (or computes it from "valid for N years"), kernel version, and restricted-renewal wording. Every value keeps the text it came from. |
| **Review** | Each letter becomes proposed changes: renewal update, replacement (not yet effective, with overlap/gap tracking), link as evidence, history, new record, or "choose the records" for family names such as `Self/5XXX`. Values can be edited before approving. "Approve safe" applies only confident, warning-free matches. |
| **Action plan** | A rules engine (no AI needed) builds explained actions: expired approvals, renewals inside each approval type's lead time, renewal waves (several devices on one date), same-day expiry groups, final/restricted extensions, chasing pending LOAs, overdue next steps, portal updates, replacements to activate, missing owners/dates/evidence. Done, snooze and dismiss. |
| **Certifications** | The register with search, health chips, filters (brand, approval type, platform, bundle, expiry window, stage, owner, disposition, portal status), sorting, bulk edit and export of any filtered set. |
| **Matrix** | Device × brand grid coloured by time to expiry, grouped by platform and bundle. |
| **Reports** | One-click summary report (PDF, HTML, print), Excel workbook (records, action plan, summary, portal changes), CSV, portal change list, digest email text, full audit log, import history. |
| **Reminders** | Windows notification daily, weekly or monthly at a chosen time, listing what to do. Runs from the tray; a missed reminder arrives when the app next starts. |
| **Local AI (optional)** | Connects to a free local model such as Google Gemma through Ollama (or any OpenAI-compatible server on your machine or LAN) for written briefings, questions about the portfolio, draft emails and help with hard-to-read letters. Internet AI services are refused. Every feature has a non-AI fallback. |
| **Imports** | Existing Excel/CSV trackers (columns recognised by name) and published portal pages (saved HTML/MHTML, PDF printout or text). Compare mode records published dates without touching verified ones. |
| **Safety** | Every field change is audited with who and where it came from. Manual edits are never overwritten by imports, and older dates never replace newer ones. Daily automatic backups, one-click restore, original LOA files archived unchanged. |

## Install (Windows)

Download from the latest build of the **Build Windows app** workflow (or a GitHub release):

- `LOA-Command-Center-Setup-x.y.z.exe`: per-user installer, no admin rights needed.
- `LOA-Command-Center-Portable-x.y.z.exe`: runs without installing.

The builds are not code-signed yet, so Windows SmartScreen may show "Windows protected your PC". Choose **More info → Run anyway**, or ask IT to allow it.

Data lives in `%LOCALAPPDATA%\LOA Command Center` (database, archived LOAs, backups). It can be moved from Settings → Data.

**Updating:** the installed app updates itself: it checks at start-up and every 12 hours, downloads new versions in the background and installs them on restart (Settings → General → Updates). The Portable exe is replaced by hand. The data folder is separate from the program, so records, LOAs and settings carry over, and uninstalling does not remove it. The first time a new version starts, it saves a copy of the previous database in `Backups` (`…-before-vX.Y.Z.db`), restorable from Settings → Data.

### Turning on the local AI (optional)

1. Install Ollama from <https://ollama.com/download>.
2. Run `ollama pull gemma3:4b` (or `gemma3:1b` on low-memory laptops).
3. In the app: Settings → AI assistant → Ollama → Test connection.

### Publishing updates

Installed apps update from this repository's GitHub releases (`build.publish` in `package.json`), so the repository must be public for them to download. Every push to `main` with a new `version` in `package.json` builds, smoke-tests and publishes release `v<version>` with the installer, the portable exe and `latest.yml`; nothing else to do. A version that is already released is skipped.

## Develop

Requires Node.js 22.

```bash
npm install
npm start            # build the UI and run the desktop app
npm test             # unit and workflow tests (fictional letters)
npm run dev:web      # same UI and API in a browser at http://127.0.0.1:5179
npm run test:ui      # browser smoke test (needs Playwright + Chromium)
npm run dist         # build the Windows installer and portable exe into release/
```

Layout:

- `src/core/`: everything that is not UI. Database (SQLite via sql.js, saved atomically), letter parser, device matching, intake and review, rules engine, importers, reports, local AI client, scheduler. Plain Node, fully testable.
- `src/ui/`: Preact interface, bundled by `scripts/build-ui.js` with the offline PDF and OCR assets.
- `electron/`: window, tray, notifications, file dialogs and the IPC bridge (only whitelisted API methods are callable).
- `dev/server.js`: the API over HTTP for browser testing; not shipped.

CI (`.github/workflows/build.yml`) runs the tests, builds the Windows exe on `windows-latest`, launches the packaged app with `--smoke-test` to prove the UI, PDF reader and OCR work, and uploads the installers.

Never commit real LOAs or exported data; `.gitignore` excludes databases and data folders.
