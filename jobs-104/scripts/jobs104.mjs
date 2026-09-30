#!/usr/bin/env node
// Read-only client for 104 job listings (www.104.com.tw).
// Uses the same JSON endpoints the 104 website calls; no login, no browser.
//
//   node jobs104.mjs search <keyword> [--area 台北市,新北市] [--cat 軟體工程師] [--salary 50000]
//                    [--remote full|part] [--sort relevance|date|salary] [--pages 1] [--json]
//   node jobs104.mjs detail <job url | job code> [--json]
//   node jobs104.mjs codes area|jobcat <name>

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const BASE = 'https://www.104.com.tw';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const PAGE_SIZE = 30;            // the API rejects anything above 30 (422)
const DELAY_MS = 1200;           // be polite between page requests
const SORT = { relevance: 15, date: 16, salary: 13 };
const REMOTE = { full: 1, part: 2 };
// Verified against the salary text of real listings (jobDetail.salary).
const SALARY_TYPE = { 10: '面議', 20: '論件', 30: '時薪', 50: '月薪', 60: '年薪', 70: '部分工時月薪' };
const CODE_TABLES = { area: 'Area', jobcat: 'JobCat' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Requests go through curl, not Node's fetch: Cloudflare in front of 104 answers
// Node's fetch with a 403 "Just a moment..." challenge, while curl is let through.
// If curl starts getting the challenge too, stop - do not try to defeat it.
async function getJson(url, referer) {
  const { stdout } = await run('curl', ['-s', '-m', '30', '-A', UA, '-H', `Referer: ${referer}`,
    '-H', 'Accept: application/json', '-w', '\n%{http_code}', url]);
  const cut = stdout.lastIndexOf('\n');
  const text = stdout.slice(0, cut), status = Number(stdout.slice(cut + 1));
  if (/<title>Just a moment/.test(text)) throw new Error(`HTTP ${status}: blocked by Cloudflare's bot check. Read the page in Chrome instead.`);
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${status}, not JSON: ${text.slice(0, 120)}`); }
  if (status !== 200 || body.error) throw new Error(`HTTP ${status}: ${body.error?.message ?? text.slice(0, 120)}`);
  return body;
}

// ---- code tables (area / job category), cached for a week ----

async function codeTable(kind) {
  const file = join(tmpdir(), `jobs104-${kind}.json`);
  try {
    if (Date.now() - (await stat(file)).mtimeMs < 7 * 864e5) return JSON.parse(await readFile(file, 'utf8'));
  } catch {}
  const data = await getJson(`https://static.104.com.tw/category-tool/json/${CODE_TABLES[kind]}.json`, BASE);
  await mkdir(tmpdir(), { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}

function flatten(nodes, out = [], depth = 0) {
  for (const n of nodes) {
    out.push({ no: n.no, des: n.des, eng: n.eng ?? '', depth });
    if (n.n) flatten(n.n, out, depth + 1);
  }
  return out;
}

async function findCodes(kind, name) {
  const all = flatten(await codeTable(kind));
  const q = name.replace(/臺/g, '台').toLowerCase();
  const norm = s => s.replace(/臺/g, '台').toLowerCase();
  const exact = all.filter(c => norm(c.des) === q);
  return exact.length ? exact : all.filter(c => norm(c.des).includes(q) || c.eng.toLowerCase().includes(q));
}

// Accepts codes as-is, otherwise resolves each comma-separated name to exactly one code.
async function resolveList(kind, value) {
  if (!value) return [];
  const codes = [];
  for (const part of value.split(',').map(s => s.trim()).filter(Boolean)) {
    if (/^\d{10}$/.test(part)) { codes.push(part); continue; }
    const hits = await findCodes(kind, part);
    if (hits.length !== 1) {
      const list = hits.slice(0, 10).map(h => `${h.no} ${h.des}`).join('\n  ');
      throw new Error(`${kind} "${part}" matched ${hits.length} entries${hits.length ? ':\n  ' + list : ''}\nPass the code, or a more exact name.`);
    }
    codes.push(hits[0].no);
  }
  return codes;
}

// ---- formatting ----

function salaryText(type, low, high) {
  if (type === 10) return '待遇面議';
  const unit = SALARY_TYPE[type] ?? `salaryType ${type}`;
  const n = v => v.toLocaleString('en-US');
  if (high >= 9999999) return `${unit} ${n(low)} 以上`;
  if (low === high) return `${unit} ${n(low)}`;
  return `${unit} ${n(low)}~${n(high)}`;
}

const REMOTE_TYPE = { 1: '完全遠端', 2: '部分遠端' };
const ABILITY = { listening: '聽', speaking: '說', reading: '讀', writing: '寫' };

// { language: '日文', ability: { listening: '精通', ... } } -> '日文(聽精通/說精通/讀精通/寫精通)'
function languageText(l) {
  const a = l.ability && typeof l.ability === 'object'
    ? Object.entries(l.ability).map(([k, v]) => `${ABILITY[k] ?? k}${v}`).join('/')
    : l.ability ?? '';
  return a ? `${l.language}(${a})` : l.language;
}

const dateText = d => (d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d);
const jobCode = url => url.split('/job/')[1]?.split(/[?#/]/)[0];

function summarize(d, promoted) {
  return {
    code: jobCode(d.link.job),
    title: d.jobName,
    company: d.custName,
    salary: salaryText(d.s10, d.salaryLow, d.salaryHigh),
    location: d.jobAddrNoDesc,
    remote: REMOTE_TYPE[d.remoteWorkType] ?? '',
    posted: dateText(d.appearDate),
    industry: d.coIndustryDesc,
    skills: (d.pcSkills ?? []).map(s => s.description),
    url: d.link.job,
    promoted,
  };
}

// ---- commands ----

async function search(keyword, opt) {
  const params = new URLSearchParams({ pagesize: String(PAGE_SIZE), order: String(SORT[opt.sort ?? 'relevance'] ?? opt.sort), asc: '0' });
  if (keyword) params.set('keyword', keyword);
  const area = await resolveList('area', opt.area);
  if (area.length) params.set('area', area.join(','));
  const cat = await resolveList('jobcat', opt.cat);
  if (cat.length) params.set('jobcat', cat.join(','));
  if (opt.salary) { params.set('scmin', opt.salary); params.set('sctp', 'M'); params.set('scstrict', '1'); }
  if (opt.remote) params.set('remoteWork', String(REMOTE[opt.remote] ?? opt.remote));
  if (!keyword && !area.length && !cat.length) throw new Error('Give a keyword, --area or --cat.');

  const pages = Math.max(1, Number(opt.pages ?? 1));
  const seen = new Set();
  const jobs = [];
  let total = 0, lastPage = 0;
  for (let page = 1; page <= pages; page++) {
    if (page > 1) await sleep(DELAY_MS);
    params.set('page', String(page));
    const body = await getJson(`${BASE}/jobs/search/api/jobs?${params}`, `${BASE}/jobs/search/?${params}`);
    ({ total, lastPage } = body.metadata.pagination);
    // 104 puts paid listings in front of the real results, ignoring the filters.
    // They are the surplus beyond the page size.
    const extra = Math.max(0, body.data.length - PAGE_SIZE);
    body.data.forEach((d, i) => {
      if (seen.has(d.jobNo)) return;
      seen.add(d.jobNo);
      jobs.push(summarize(d, i < extra));
    });
    if (page >= lastPage) break;
  }
  return { total, lastPage, query: Object.fromEntries(params), jobs };
}

async function detail(ref) {
  const code = ref.includes('/job/') ? jobCode(ref) : ref;
  if (!code) throw new Error(`Not a job url or code: ${ref}`);
  const { data } = await getJson(`${BASE}/job/ajax/content/${code}`, `${BASE}/job/${code}`);
  const jd = data.jobDetail, c = data.condition;
  return {
    code,
    url: `${BASE}/job/${code}`,
    title: data.header.jobName,
    company: data.header.custName,
    companyUrl: data.header.custUrl,
    industry: data.industry,
    employees: data.employees,
    posted: data.header.appearDate,
    closes: data.closeDate || '',
    salary: jd.salary,
    categories: jd.jobCategory.map(x => x.description),
    workType: jd.workType,
    address: `${jd.addressRegion}${jd.addressDetail}`,
    landmark: jd.landmark,
    hours: jd.workPeriod?.note ?? '',
    remote: jd.remoteWork ? [REMOTE_TYPE[jd.remoteWork.type], jd.remoteWork.description].filter(Boolean).join(':') : '',
    vacation: jd.vacationPolicy,
    start: jd.startWorkingDay,
    headcount: jd.needEmp,
    businessTrip: jd.businessTrip,
    description: jd.jobDescription.trim(),
    experience: c.workExp,
    education: c.edu,
    majors: c.major,
    languages: [...c.language, ...c.localLanguage].map(languageText),
    skills: [...c.specialty, ...c.skill].map(s => s.description),
    certificates: c.certificate.map(x => x.name),
    otherRequirements: (c.other ?? '').trim(),
    welfare: (data.welfare.welfare ?? '').trim(),
    welfareTags: data.welfare.tag ?? [],
    contact: data.contact.hrName,
    replyPolicy: data.contact.reply,
  };
}

function printSearch(r) {
  console.log(`共 ${r.total} 筆,這裡列出 ${r.jobs.length} 筆(每頁 ${PAGE_SIZE},共 ${r.lastPage} 頁)\n`);
  r.jobs.forEach((j, i) => {
    const tag = j.promoted ? ' [廣告/置頂]' : '';
    console.log(`${i + 1}. ${j.title}${tag}`);
    console.log(`   ${j.company} | ${j.salary} | ${j.location}${j.remote ? ' | ' + j.remote : ''} | ${j.posted}`);
    console.log(`   ${j.url}`);
  });
}

function printDetail(d) {
  const line = (k, v) => v && (!Array.isArray(v) || v.length) && console.log(`${k}: ${Array.isArray(v) ? v.join('、') : v}`);
  console.log(`# ${d.title}\n`);
  line('公司', `${d.company}(${d.industry},${d.employees})`);
  line('網址', d.url);
  line('薪資', d.salary);
  line('地點', `${d.address}${d.landmark ? '(' + d.landmark + ')' : ''}`);
  line('遠端', d.remote);
  line('職務類別', d.categories);
  line('工作性質', d.workType);
  line('上班時段', d.hours);
  line('休假', d.vacation);
  line('可上班日', d.start);
  line('需求人數', d.headcount);
  line('出差', d.businessTrip);
  line('刊登', d.posted);
  line('截止', d.closes);
  console.log('\n## 工作內容\n' + d.description);
  console.log('\n## 條件');
  line('經歷', d.experience);
  line('學歷', d.education);
  line('科系', d.majors);
  line('語文', d.languages);
  line('技能', d.skills);
  line('證照', d.certificates);
  if (d.otherRequirements) console.log('\n其他條件:\n' + d.otherRequirements);
  if (d.welfare || d.welfareTags.length) console.log('\n## 福利\n' + [d.welfareTags.join('、'), d.welfare].filter(Boolean).join('\n'));
  console.log('\n## 聯絡');
  line('聯絡人', d.contact);
  line('回覆', d.replyPolicy);
}

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      opt[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else pos.push(argv[i]);
  }
  return { pos, opt };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  const out = (value, printer) => (opt.json ? console.log(JSON.stringify(value, null, 2)) : printer(value));
  if (cmd === 'search') return out(await search(pos.join(' '), opt), printSearch);
  if (cmd === 'detail' && pos[0]) return out(await detail(pos[0]), printDetail);
  if (cmd === 'codes' && CODE_TABLES[pos[0]] && pos[1]) {
    for (const h of await findCodes(pos[0], pos.slice(1).join(' '))) console.log(`${h.no}  ${'  '.repeat(h.depth)}${h.des}`);
    return;
  }
  console.error('usage: jobs104.mjs search <keyword> [--area X] [--cat X] [--salary N] [--remote full|part] [--sort relevance|date|salary] [--pages N] [--json]\n' +
                '       jobs104.mjs detail <job url|code> [--json]\n' +
                '       jobs104.mjs codes area|jobcat <name>');
  process.exitCode = 2;
}

export { salaryText, languageText, summarize, parseArgs, search, detail };

// Compare real paths: the skill is installed through a junction, and Node reports
// import.meta.url for the resolved target, not the path it was started with.
const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main().catch(e => { console.error(`jobs104: ${e.message}`); process.exitCode = 1; });
}
