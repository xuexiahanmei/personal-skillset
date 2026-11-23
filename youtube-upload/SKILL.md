---
name: youtube-upload
description: "Upload videos to the user's own YouTube channel through the official YouTube Data API - title, description, tags, privacy (private, unlisted, public), scheduled publishing, playlist, custom thumbnail, made-for-kids and altered/AI-content flags - with resumable uploads for large files. Also checks processing status and edits or publishes videos already uploaded. Use this whenever the user wants a video file put on YouTube, published, scheduled, or its YouTube title, description, tags, thumbnail or visibility changed, even when they only give a file path. Triggers include English requests like 'upload this video to YouTube', 'schedule it for Friday 8pm', 'make my last video public', and Traditional Chinese ones: 幫我上傳影片到 YouTube, 把這支影片上架, 上傳到我的頻道, 排程週五晚上八點公開, 設成不公開, 改一下標題, 換縮圖, 加到播放清單, 影片處理好了沒."
---

# YouTube upload

Everything goes through `scripts/ytupload.mjs` (Node 18+, no dependencies).

```
S=~/.claude/skills/youtube-upload/scripts/ytupload.mjs

node $S auth                         # one-time Google sign-in (opens the browser)
node $S whoami                       # which channel the sign-in points at
node $S upload <video> [options]     # upload; prints the video id and links
node $S status <id|link>             # processing state, privacy, rejection reason
node $S update <id|link> [options]   # change metadata or visibility of an uploaded video
node $S thumbnail <id|link> <image>  # set a custom thumbnail (.jpg/.png, max 2 MB)
node $S playlists                    # the channel's playlists
node $S categories [--region TW]     # category ids for --category
```

Add `--json` to any command for structured output.

## First-time setup

Credentials live in `~/.youtube-upload/` (`client_secret.json`, `token.json`,
and upload sessions), never in the repo. Override with `YTUPLOAD_HOME`.

If `whoami` says `no OAuth client` or `not signed in`, walk the user through
[references/setup.md](references/setup.md). It takes about ten minutes and the
user has to click through the Google Cloud console themselves. Then run `auth`
**with `run_in_background`**: it waits up to 5 minutes for the user to finish
signing in in the browser it opens. Tell the user to pick the Google account that
owns the channel, and that the "Google hasn't verified this app" screen is
expected (Advanced, then Go to ...). When it finishes, show the channel it
printed and ask the user to confirm it is the right one.

## Uploading

| Option | Meaning | Default |
| --- | --- | --- |
| `--title` | at most 100 characters, no `<` `>` | the file name |
| `--description` / `--description-file` | at most 5000 **bytes** (a Chinese character is 3) | empty |
| `--tags` | comma separated (`,` `，` `、`), at most 500 characters in total | none |
| `--privacy` | `private`, `unlisted`, `public` | `private` |
| `--publish-at` | schedule; keeps it private until then. `2026-11-01 20:00` is local time | - |
| `--playlist` | playlist id, or its title (exact, else a unique partial match) | - |
| `--thumbnail` | .jpg or .png, max 2 MB | YouTube picks a frame |
| `--category` | category id from `categories` | `22` (People & Blogs) |
| `--language` | language of title and audio, e.g. `zh-TW`, `en` | unset |
| `--kids` | made for kids, `yes`/`no` | `no` |
| `--synthetic` | contains realistic altered or AI-generated content, `yes`/`no` | unset |
| `--no-notify` | do not notify subscribers | notify |
| `--dry-run` | validate and print everything, upload nothing | - |

Steps:

1. **Check the file and the channel.** The file must exist; run `whoami` once per
   session so you know which channel you are about to post to.
2. **Settle the metadata.** Use what the user gave. If they gave no title or
   description, draft them from what you know (the file name, what the user said
   about the video, earlier conversation). You cannot watch the video, so if you
   know nothing about its content, ask in one line rather than invent it. Put a
   multi-line description in a UTF-8 file in the scratchpad and pass
   `--description-file`.
3. **Dry-run, then confirm.** Run the same command with `--dry-run`. Show the
   user the title, privacy (and schedule), playlist and the start of the
   description, and get a yes **before any upload you wrote the text for, and
   before any public or unlisted upload**. A private upload with the user's own
   title can go straight ahead. Uploading publishes to the user's audience and
   can notify subscribers, so do not skip this to save a turn.
4. **Upload.** For anything over about 200 MB, run it with `run_in_background`;
   progress goes to stderr every 5%. A small file can run in the foreground.
5. **Report** the watch link, the privacy, and any `WARNING:` lines. Exit code 3
   means the video is up but a follow-up step (playlist, thumbnail) failed: the
   warning says which, and it can be redone with `update` / `thumbnail` without
   uploading again.

`--kids`: ask the user if the video looks aimed at children (cartoons,
toys, nursery songs). This is a legal declaration, not a reach setting.

`--synthetic yes`: set it when the video has realistic content that was altered
or generated, such as a voice cloned with the `cloned-voice` skill, a real
person's face or voice made to say something they did not, or realistic
AI-made scenes. YouTube requires this disclosure. It is not needed for obvious
animation, beauty filters, or AI used only for scripts or captions. If unsure,
ask the user.

**Shorts** are automatic: a vertical or square video of 3 minutes or less
becomes a Short. There is no option for it.

## Interrupted uploads

The upload is sent in 16 MB pieces and retries on its own after network errors
and server errors (up to 8 times in a row, backing off up to a minute). If it
still fails, **run exactly the same command again**: it finds the saved session
and continues from the last byte YouTube confirmed (the output says
`Resuming`). Sessions last about a week. Changing any metadata starts a fresh
upload instead, so keep the options identical when resuming.

## After uploading

- `status <id>` shows `uploadStatus` (`uploaded` → `processed`; `failed` or
  `rejected` come with a reason) and processing time left. A video is watchable
  soon after upload but HD takes longer.
- **Publish now / change visibility:** `update <id> --privacy public`. This also
  cancels a schedule. `update <id> --publish-at "..."` reschedules.
- `update` changes only what you pass. It reads the video first and sends back
  the fields it does not touch, because YouTube resets any field left out.

## If a video comes back private

For years, uploads from an unaudited Google Cloud project were locked to private.
As of this writing, the `videos.insert` reference says
"Videos uploaded from unverified API projects are not restricted to private
viewing mode", but the YouTube Help Center page on locked videos still describes
the old lock. The script compares the privacy YouTube returned with the one
requested and warns when they differ.

If that warning appears:

1. `status <id>`. If it is `private` with no schedule while you asked for public,
   try `update <id> --privacy public` once.
2. If that fails or it stays private, open the `studio` link in the user's Chrome
   with the Claude in Chrome tools and read the notice on the video page.
3. If Studio says the video is **locked as private because it was uploaded
   through an unverified API service**, it cannot be changed or appealed. Tell
   the user plainly. The ways forward are: upload that video through YouTube
   Studio by hand, or apply for an API audit for the project at
   https://support.google.com/youtube/contact/yt_api_form . Do not try to get
   around the lock.

## Limits

- **100 uploads a day** per Google Cloud project (a separate "Video Uploads"
  quota). Other calls draw on the default 10,000 units a day: `update`,
  `thumbnail` and adding to a playlist cost 50 units, reads cost 1. Older guides
  say an upload costs 1,600 units; that is out of date. Quotas reset at midnight
  Pacific time.
- **Videos over 15 minutes need a verified channel.** `whoami` shows
  `longUploads`; `allowed` is fine, `eligible` means the user should verify at
  https://www.youtube.com/verify first. Custom thumbnails need the same.
- Files up to 256 GB or 12 hours.
- YouTube also caps uploads per channel per day; an
  `uploadLimitExceeded` error means try tomorrow.

## What not to do

- Upload only files the user named, to the channel `whoami` shows.
- Never delete videos; the script has no delete. Point the user to Studio.
- Do not change visibility, titles or thumbnails of videos the user did not
  mention.
- Do not upload content the user does not have the rights to (other people's
  videos or music) because they asked casually; say that YouTube will flag or
  remove it and let them decide.

## Testing

`tests/run.mjs` checks the helpers and runs full uploads against a local mock of
the YouTube API, including a 503, a dropped connection, and a failed upload that
resumes on the next run. Nothing goes to YouTube.

```
node ~/.claude/skills/youtube-upload/tests/run.mjs
```

To try the real thing, upload a short clip with `--privacy private`, check it
with `status`, and delete it in Studio.
