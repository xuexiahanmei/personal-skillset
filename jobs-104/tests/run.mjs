// node tests/run.mjs            offline checks + one small live search and detail
// JOBS104_OFFLINE=1 node ...    offline checks only
import assert from 'node:assert/strict';
import { salaryText, languageText, summarize, parseArgs, allTermsMatcher, search, detail } from '../scripts/jobs104.mjs';

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

await check('salaryText', () => {
  assert.equal(salaryText(10, 0, 0), '待遇面議');
  assert.equal(salaryText(50, 35000, 45000), '月薪 35,000~45,000');
  assert.equal(salaryText(60, 3000000, 9999999), '年薪 3,000,000 以上');
  assert.equal(salaryText(30, 196, 196), '時薪 196');
  assert.equal(salaryText(99, 1, 2), 'salaryType 99 1~2');
});

await check('languageText', () => {
  assert.equal(languageText({ language: '日文', ability: { listening: '精通', writing: '略懂' } }), '日文(聽精通/寫略懂)');
  assert.equal(languageText({ language: '英文' }), '英文');
});

await check('summarize (anonymized listing)', () => {
  const s = summarize({
    jobName: '範例工程師', custName: '範例股份有限公司', s10: 50, salaryLow: 50000, salaryHigh: 70000,
    jobAddrNoDesc: '台北市中山區', remoteWorkType: 2, appearDate: '20260102', coIndustryDesc: '軟體業',
    pcSkills: [{ description: 'Python' }], link: { job: 'https://www.104.com.tw/job/abc12?jobsource=x' },
  }, false);
  assert.equal(s.code, 'abc12');
  assert.equal(s.salary, '月薪 50,000~70,000');
  assert.equal(s.remote, '部分遠端');
  assert.equal(s.posted, '2026-01-02');
  assert.deepEqual(s.skills, ['Python']);
});

await check('allTermsMatcher', () => {
  const m = allTermsMatcher('AI Java');
  assert.ok(m('Java 後端工程師,使用 AI 工具開發'));
  assert.ok(m('資深 java engineer (ai-assisted)'));
  assert.ok(!m('JavaScript 前端,AI 產品'), 'Java must not match JavaScript');
  assert.ok(!m('Java 工程師,請寄 Email'), 'AI must not match inside Email');
  assert.ok(allTermsMatcher('Java 遠端')('Java 軟體工程師(遠端)'));
  assert.ok(allTermsMatcher('C++')('熟悉 C++ 與 Python'));
});

await check('parseArgs', () => {
  const { pos, opt } = parseArgs(['python', 'django', '--area', '台北市', '--json']);
  assert.deepEqual(pos, ['python', 'django']);
  assert.deepEqual(opt, { area: '台北市', json: true });
});

if (!process.env.JOBS104_OFFLINE) {
  let code;
  await check('live search', async () => {
    const r = await search('python', { area: '台北市' });
    assert.ok(r.total > 0, 'no results');
    assert.equal(r.query.area, '6001001000');
    const real = r.jobs.filter(j => !j.promoted);
    assert.ok(real.length > 0 && real.length <= 30);
    assert.ok(real.every(j => j.location.startsWith('台北市')), 'a non-promoted job is outside 台北市');
    code = real[0].code;
  });
  await check('live search --all', async () => {
    const r = await search('AI Java', { all: true });
    assert.ok(r.all && r.scanned > r.jobs.length, 'filter removed nothing');
  });
  await check('live detail', async () => {
    assert.ok(code, 'search gave no job code');
    const d = await detail(`https://www.104.com.tw/job/${code}`);
    assert.equal(d.code, code);
    assert.ok(d.title && d.company && d.description && d.salary);
  });
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
