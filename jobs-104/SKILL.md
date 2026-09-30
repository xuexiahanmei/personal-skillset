---
name: jobs-104
description: "Search and read job listings on 104 人力銀行 (www.104.com.tw), Taiwan's largest job site, through the same JSON the website uses - no login, no browser needed. Use this whenever the user wants to look for jobs on 104, see what openings exist for a role, skill, company or area, compare salaries or requirements, read the full content of a 104 job link, or shortlist jobs - even when they only paste a 104.com.tw/job/ link. Triggers include English requests like 'find Python jobs in Taipei on 104', 'what does this 104 job require', and Traditional Chinese ones: 幫我找 104 的工作, 104 上有什麼後端職缺, 找台北月薪五萬以上的工作, 看一下這個 104 職缺, 這份工作的條件是什麼, 幫我整理 104 職缺, 遠端工作有哪些."
---

# 104 jobs

Everything goes through `scripts/jobs104.mjs` (Node 18+, uses the system `curl`).
It only reads public listings. It never logs in, saves, or applies.

```
S=~/.claude/skills/jobs-104/scripts/jobs104.mjs

node $S search <keyword> [options]     # list jobs
node $S detail <job url | job code>    # one job, in full
node $S codes area|jobcat <name>       # look up a 104 code
```

Add `--json` to `search` or `detail` for structured output when you need to
filter, sort or compare the results yourself.

## Searching

| Option | Meaning | Example |
| --- | --- | --- |
| `--area` | area names or codes, comma separated | `--area 台北市,新北市` |
| `--cat` | job category names or codes | `--cat 軟體工程師` |
| `--salary` | monthly minimum; drops 面議 jobs | `--salary 50000` |
| `--remote` | `full` or `part` | `--remote full` |
| `--sort` | `relevance` (default), `date`, `salary` | `--sort date` |
| `--pages` | how many pages of 30 to fetch | `--pages 3` |
| `--all` | keep only jobs containing **every** keyword | `--all` |

**Several keywords are OR on 104.** `AI Java` returns about 30,000 jobs, most of
them only AI or only Java. When the user means both, as in "AI+Java 的職缺",
use `--all` with a few pages:

```
node $S search "AI Java" --all --pages 5
```

`--all` checks each job's title, description and listed skills. English words
match as whole words, so `Java` does not match JavaScript and `AI` does not match
Email. Chinese words match anywhere. It filters what was fetched, so the result
is "N of the M scanned", not a count across all of 104. More pages find more.
Even then, a job can pass on a passing mention, such as "welcome to use AI
tools", so read `detail` before calling something an AI job.

A keyword is optional when `--area` or `--cat` is given. Names are matched against
104's own code tables. `臺` and `台` are treated as the same character. A name that
matches more than one entry is an error that lists the candidates. For example,
`大安區` exists in both Taipei and Taichung, so pass `台北市大安區` or the code.
`codes` shows what is available:

```
node $S codes area 新竹        # 6001006000 新竹縣市, then 新竹市, 新竹縣竹北市, ...
node $S codes jobcat 工程師
```

Each result has title, company, salary, district, remote type, date posted and
URL. `--json` adds the job code, industry and listed skills.

## Reading one job

`detail` takes a full URL (`https://www.104.com.tw/job/95dui`, query string
fine) or just the code (`95dui`). It returns the job description, salary text as
104 writes it, address, hours, headcount, requirements (experience, education,
majors, languages with 聽/說/讀/寫 level, skills, certificates, free-text
conditions), benefits, the contact name and the reply policy, and the closing date
when there is one.

When the user wants a shortlist, search first, then run `detail` only on the jobs
worth a closer look. Each detail is one request.

## Things that will mislead you

- **The first results are ads.** 104 puts about two paid listings in front of
  every page, and they **ignore the filters**: a `--remote full` search still
  starts with office jobs. The script marks them `[廣告/置頂]` / `promoted: true`.
  Leave them out of counts and recommendations, or say plainly that they are ads.
- **`total` is the real count, but only about 3,000 results are reachable.** The
  API stops at page 100 of 30. Narrow the search instead of paging deeper.
- **待遇面議 means no number was posted.** In Taiwan the law requires a posted
  minimum for monthly pay under NT$40,000, so 面議 usually means at least that.
  It is not a salary, so do not compare it as one. `--salary` excludes these jobs.
- **`以上` means there is no upper bound.** 104 stores it as 9,999,999.
- **Salary units differ:** 月薪, 年薪, 時薪, 論件 (per piece) and 部分工時月薪
  (part-time monthly). Convert before comparing, and say that you did.
- **Sort orders were worked out by probing, not from documentation.** `salary`
  sorts by the raw low end of the range and **ignores the unit**, so yearly pay
  (年薪 2,000,000) lands above every monthly salary. `date` is applied loosely.
  For "highest paid" or "newest", fetch the results and rank them yourself with
  `--json`.

## Limits and manners

- Pages are fetched 1.2 s apart. Keep `--pages` small. This tool is for reading
  jobs for the user, not for mirroring 104.
- Requests go through `curl` because Cloudflare in front of 104 blocks Node's
  own `fetch` (a 403 "Just a moment..." page). If curl starts getting that page
  too, the script says so. **Do not try to get around the check.** Open the job
  page in Chrome with the Claude in Chrome tools and read it with
  `get_page_text` instead.
- Saving jobs, following companies and applying need the user's 104 login and
  are out of scope. Never apply for a job on the user's behalf.

## Testing

`tests/run.mjs` checks the formatting helpers offline. It also runs one small
live search and one detail, unless `JOBS104_OFFLINE=1` is set:

```
node ~/.claude/skills/jobs-104/tests/run.mjs
```
