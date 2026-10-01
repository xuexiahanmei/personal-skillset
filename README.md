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

## 規則

- **私人資料不進 repo。** 聊天匯出、訊息 dump、截圖都是真人的對話。放在 `exports/`、`private/`、`screenshots/`(已被 `.gitignore` 擋掉),或乾脆放在 repo 外面。
- **測試用的 fixture 要匿名化。** 從真實畫面抄結構可以,名字、ID、內容要換成假的。
- **`.ps1` 保持純 ASCII**(或存成 UTF-8 **with BOM**)。Windows PowerShell 5.1 會用 ANSI 讀沒有 BOM 的檔案,中文字面值會壞掉。`.gitattributes` 只管換行,不管編碼。
- 每個 skill 自己的測試放在它的 `tests/` 裡,`node_modules` 不進 repo。
