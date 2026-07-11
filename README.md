# Trip Splitter (Google Sheets edition)

A GitHub-Pages-hostable clone of the [split-app](../split-app) expense
splitter. Same UI and same balance math, but the "database" is a Google
Sheet instead of a local JSON file, and the "server" is a Google Apps Script
Web App instead of Express.

## Why it's different from split-app

split-app runs on a laptop on your wifi — the Express server is the only
thing that can read/write `db.json`, so it can safely allow deleting people
and expenses (soft-delete, with backups).

This version is a fully static site (just HTML/CSS/JS) that anyone in the
world can view the source of once it's on GitHub Pages. That changes two
things on purpose:

- **No delete buttons.** Removing a person or an expense here would mean
  giving every visitor's browser a way to delete rows in your spreadsheet.
  Instead: fix mistakes by editing the Google Sheet directly (delete the row,
  or just edit the wrong cell). The People and Expenses tabs both have a note
  reminding you of this.
- **The "shared key" is not real security.** It's a shared secret sitting in
  plain text in `app.js`, which anyone can view via "View Source". It stops
  casual/accidental writes from other scripts hitting your endpoint, not a
  determined person. Don't put anything sensitive in the sheet.

Everything else — adding people, adding expenses, balances, the simplified
"who pays who" settle-up list, marking a settlement as paid, and an activity
log — works the same way it does in split-app.

## Setup

### 1. Create the Google Sheet + Apps Script backend

1. Create a new Google Sheet (sheets.new). Name it whatever you like.
2. In the Sheet, go to **Extensions > Apps Script**.
3. Delete the placeholder code and paste in the contents of
   [`apps-script/Code.gs`](apps-script/Code.gs).
4. At the top of the script, change `SHARED_KEY` to your own random string
   (e.g. mash the keyboard for 20 characters).
5. Click **Deploy > New deployment**.
   - Click the gear icon next to "Select type" and choose **Web app**.
   - Execute as: **Me**.
   - Who has access: **Anyone**.
   - Click **Deploy**, and authorize it when prompted (you'll see an
     "unverified app" warning since this is your own script — click
     **Advanced > Go to (project name)** to proceed).
6. Copy the **Web app URL** it gives you (ends in `/exec`). You'll need it in
   step 2.
7. The first time someone adds a person or expense, the script will
   auto-create the `People`, `Expenses`, and `Log` tabs with the right
   headers — you don't need to set those up by hand.

### 2. Point the frontend at it

Open `app.js` in this folder and edit the top two constants:

```js
const API_URL = 'https://script.google.com/macros/s/XXXXXXXX/exec'; // your URL from step 1.6
const SHARED_KEY = 'change-me-to-a-random-string'; // must match Code.gs exactly
```

### 3. Host it on GitHub Pages

Push this folder (`index.html`, `style.css`, `app.js`) to a GitHub repo, then
in the repo's **Settings > Pages**, set the source to the branch/folder
you pushed to. GitHub will give you a `https://<user>.github.io/<repo>/` URL
— that's the link to share with your group.

## If you ever redeploy the Apps Script

Editing `Code.gs` after the fact requires a **new deployment** (or "Manage
deployments > Edit > New version") for the changes to actually go live — just
saving the script doesn't update the running `/exec` endpoint.

## Backups

Unlike split-app, there's no custom backup system here — Google Sheets keeps
automatic version history (**File > Version history > See version history**)
covering the same "undo an accidental change" need. For anything longer-term,
File > Make a copy periodically, or File > Download as .xlsx.

## Limitations to know about

- **Latency**: every read/write is a real network call to Apps Script, which
  is noticeably slower than split-app's local file access (expect anywhere
  from a few hundred ms to a couple seconds per action).
- **No real-time sync**: like split-app, other people's changes only show up
  when you switch tabs (which re-fetches). There's no push/websocket.
- **Apps Script quotas**: consumer Google accounts get roughly 90 minutes of
  script execution per day and per-minute call limits. Fine for a trip-sized
  group; not meant for heavy traffic.
- **Concurrent writes**: the script uses `LockService` to serialize writes
  so two people saving at the exact same moment can't corrupt a row, but
  under heavy simultaneous use you may occasionally see a "Server busy, try
  again" error — just retry.
