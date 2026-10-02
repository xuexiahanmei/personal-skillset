# personal-skillset

個人用的 Claude Code skills。每個子資料夾是一個 skill(`<name>/SKILL.md`)。

| Skill | 做什麼 |
| --- | --- |
| [`line-bridge`](line-bridge/SKILL.md) | 讀取、回覆、自動回覆、匯出、即時監看 LINE 聊天(預設用 LINE Chrome 擴充功能,桌面版只在同意後備用) |
| [`discord-bridge`](discord-bridge/SKILL.md) | 讀取、回覆、即時監看 Discord(瀏覽器上自己已登入的分頁) |

## 安裝

Claude Code 只會從 `~/.claude/skills/<name>/SKILL.md` 載入個人 skill,放在這個 repo 裡不會被自動掃到。
每個 skill 建一個目錄連結(junction),repo 仍是唯一的來源,改了馬上生效:

```powershell
$repo = 'C:\dev-workspace\tools\personal-skillset'
foreach ($skill in Get-ChildItem $repo -Directory | Where-Object { Test-Path "$($_.FullName)\SKILL.md" }) {
    $link = "$env:USERPROFILE\.claude\skills\$($skill.Name)"
    if (-not (Test-Path $link)) { New-Item -ItemType Junction -Path $link -Target $skill.FullName | Out-Null }
}
```

不要放進 `~/.claude/skills/synced/`,那是系統同步的資料夾,會被覆蓋。

## line-bridge 的 MCP 工具

`line-bridge` 另外帶一個 MCP server(`line-bridge/mcp/server.mjs`),把 LINE Chrome 擴充頁包成 `line_status`、`line_read`、`line_send` 等八個工具。註冊寫在 repo 根目錄的 `.mcp.json`(project scope),所以**只有在這個 repo 開的 Claude Code session 會載入**。

第一次使用:

```powershell
cd line-bridge\mcp;   npm ci    # server 的相依:官方 MCP SDK(@modelcontextprotocol/server)與 zod
cd ..\tests;          npm ci    # 只有要跑測試才需要
```

然後在這個 repo 開一個新的 session,Claude Code 會問要不要啟用專案的 `line-bridge` server,核准一次即可(`claude mcp get line-bridge` 可以看狀態)。之後請 Claude 做 LINE 的事,它會先呼叫 `line_setup`,你在 LINE 擴充頁的 DevTools console 貼一次;頁面重新載入後才需要再貼。

- **權限**寫在 `.claude/settings.json`:讀取類工具免確認;`line_send`、`line_follow` 每次都會跳確認框(框裡看得到聊天室和全文);自動回覆走 `line_reply`,只在你於 `line_follow` 確認框核准的聊天室、則數、時限內有效。
- **私人資料**(token、事件記錄、訊息 dump)放在 `%LOCALAPPDATA%\line-bridge\`,不在 repo 裡;可用環境變數 `LINE_BRIDGE_DIR`、`LINE_BRIDGE_PORT`(預設 38766)改位置與埠。資料目錄若在任何 git 工作樹內,server 會拒絕啟動。
- **要讓所有專案都能用**:`claude mcp add --scope user line-bridge -- node <這個 repo 的絕對路徑>\line-bridge\mcp\server.mjs`,並把 `.claude/settings.json` 裡那幾條 `mcp__line-bridge__*` 規則加到 `~/.claude/settings.json`。
- 沒有 MCP 工具的 session 仍可用舊路徑(DevTools console 橋接 + `relay.py`),見 `line-bridge/references/devtools-bridge.md`。

## 規則

- **私人資料不進 repo。** 聊天匯出、訊息 dump、截圖都是真人的對話。放在 `exports/`、`private/`、`screenshots/`(已被 `.gitignore` 擋掉),或乾脆放在 repo 外面。
- **測試用的 fixture 要匿名化。** 從真實畫面抄結構可以,名字、ID、內容要換成假的。
- **`.ps1` 保持純 ASCII**(或存成 UTF-8 **with BOM**)。Windows PowerShell 5.1 會用 ANSI 讀沒有 BOM 的檔案,中文字面值會壞掉。`.gitattributes` 只管換行,不管編碼。
- 每個 skill 自己的測試放在它的 `tests/` 裡,`node_modules` 不進 repo。
