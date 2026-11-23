# One-time setup

The script signs in as the user with OAuth. Google needs a Cloud project and an
OAuth client for that. Everything here is free and happens in the user's own
Google account. The console's menu names change from time to time; if a name
below does not match, use the console's search bar.

## 1. Create a Google Cloud project

1. Open https://console.cloud.google.com/ while signed in to the Google account
   that owns the YouTube channel (or any account; the channel is chosen at sign-in).
2. Project picker (top left) → **New project**, name it e.g. `youtube-upload` → Create.
   Make sure it is the selected project afterwards.

## 2. Enable the YouTube Data API v3

https://console.cloud.google.com/apis/library/youtube.googleapis.com → **Enable**.

## 3. Configure the consent screen

**Google Auth Platform** (APIs & Services → OAuth consent screen) → **Get started**:

- App name: anything, e.g. `youtube-upload`. Support email: the user's.
- Audience: **External**.
- Contact email: the user's. Agree and create.

Then under **Audience**:

- Add the user's own Google account under **Test users**, so sign-in works
  right away.

## 4. Create the OAuth client

**Google Auth Platform → Clients → Create client**:

- Application type: **Desktop app**. Name: anything.
- Create, then **Download JSON**.
- Save it as `~/.youtube-upload/client_secret.json`
  (on Windows: `%USERPROFILE%\.youtube-upload\client_secret.json`).

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.youtube-upload" | Out-Null
Move-Item "$env:USERPROFILE\Downloads\client_secret_*.json" "$env:USERPROFILE\.youtube-upload\client_secret.json"
```

The file holds a client secret. Keep it out of git and do not paste it into chat.

## 5. Sign in

```
node ~/.claude/skills/youtube-upload/scripts/ytupload.mjs auth
```

A browser tab opens. Pick the account that owns the channel. If the account has
several channels (brand accounts), pick the channel there too.

"Google hasn't verified this app" is expected for a personal project: **Advanced
→ Go to youtube-upload (unsafe)**. Allow access. The terminal prints the channel.

If the browser does not open, add `--no-browser` and open the printed URL by hand
on the same computer (the sign-in returns to `http://127.0.0.1:<port>`).

## Stop the sign-in from expiring

While the app's publishing status is **Testing**, Google expires the sign-in
after **7 days**, and the script then says to run `auth` again.

To avoid that: **Google Auth Platform → Audience → Publish app** (status becomes
"In production"). No review is needed for personal use; the only change is that
the sign-in shows the "unverified app" screen above. Run `auth` once more after
publishing. Unverified apps are limited to 100 users, which does not matter here.

## Revoking access

https://myaccount.google.com/permissions → the app → Remove access. Delete
`~/.youtube-upload/token.json` too.
