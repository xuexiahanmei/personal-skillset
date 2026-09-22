# LINE "Save chat" export

LINE desktop's `...` menu -> **Save chat** writes the whole conversation as text.
`Export-LineChat` drives it; `parse_export.py` turns the file into JSONL. Use it for
complete history as exact text when reply quotes do not matter - it is also the
ground truth to check anything else against.

```powershell
. "$SkillDir\scripts\line-bridge.ps1"
$chat = Open-LineChatByName -Name "王小明"
Export-LineChat -Win $chat -Path "$private\wang.txt"          # 1:1 chat
Export-LineChat -Win $chat -Path "$private\memo.txt" -MenuItemY 208   # Keep Memo menu
```

```bash
python scripts/parse_export.py "$private/wang.txt"            # -> wang.jsonl + summary
python scripts/parse_export.py "$private/wang.txt" --sender "王小明" --sender "李小華"
```

Keep exports out of any repository - they are the user's private conversations.

## Cost of running it

About ten seconds, and opening the menu needs the chat window active (Qt will not
raise a popup for an inactive window), so it is the one step that takes focus and
it does not work while the session is locked. The file itself is small: a
two-year, 1019-message chat was 40 KB. Exporting often is cheap in space; it is the
interruption that makes it a poor real-time mechanism.

The same export repeated produced byte-identical files.

## Format

UTF-8, no BOM, CRLF line endings, fields separated by a plain **space** (the phone
export uses the same layout - it is not tab-separated here).

```
2024.09.18 Wednesday          date header
18:48 王小明 你考試考得怎樣        HH:MM <sender> <body>
還在等成績                     continuation of the previous message (Shift+Enter)
15:50 Message unsent.         unsent message - no sender field at all
```

A display name can contain spaces, so the sender is not "the first token":
`parse_export.py` learns the set of senders from the whole file first and matches
the longest known name at the start of each line.

| Content | Appears as |
| --- | --- |
| Text | verbatim |
| Multi-line text | following lines with no `HH:MM` |
| Sticker | `Stickers` |
| Photo / video / file | `Photos` / `Videos` / `Files` |
| Call | its duration, e.g. `00:14` |
| Unsent message | `HH:MM Message unsent.` |
| Location | the Google Maps URL |

## What it drops

- **Reply quotes - confirmed three ways.** A reply is written as an ordinary line
  with nothing pointing at what it answered. Tested by sending `TEST_A`, `TEST_B`,
  then a reply to `TEST_A` in Keep Memo and exporting: `TEST_A` appeared once (the
  original) and the reply was a bare line. The phone export does the same (2844
  messages, no reply marker), and right-click -> Copy on a reply copies only the body.
- Emoji reactions (the extension DOM has them - `extension-dom.md`).
- Read receipts, and time finer than the minute.

For replies, read the Chrome extension's DOM instead (`extension-dom.md`).

## Dead ends - do not re-investigate

- **The local database** `%LOCALAPPDATA%\LINE\Data\db\<id>.edb` (hundreds of MB,
  with `-wal`/`-shm`) is SQLCipher-encrypted: its header is not `SQLite format 3`.
  Reading it means pulling the key out of LINE.exe's memory.
- **UI Automation** on the Qt window exposes ~78 elements, none with a name, and the
  Text/Value patterns they advertise return nothing.
- **Network capture**: certificate pinning, and chats are end-to-end encrypted
  (Letter Sealing).
- **The Chrome extension's storage** (IndexedDB ~39 KB) holds no message history.
- **Windows notification DB** (`%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`)
  is plain SQLite and LINE toasts carry sender + text, but muted chats never notify,
  rows vanish when a toast is dismissed, and there are no quotes. A secondary signal
  at best.
