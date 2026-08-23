import { webkit } from '/opt/homebrew/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const D = '/Users/am/safari-tooltip-translator/';
const files = ['test/shim.js','extension/content.js','extension/blocks.js','extension/captions.js']
  .map(f => readFileSync(D+f,'utf8'));
const css = readFileSync(D+'extension/content.css','utf8');

const sites = [
  ['Wikipedia', 'https://en.wikipedia.org/wiki/Lighthouse'],
  ['BBC News',  'https://www.bbc.com/news'],
  ['Hacker News','https://news.ycombinator.com/'],
  ['MDN docs','https://developer.mozilla.org/en-US/docs/Web/API/AudioContext'],
  ['GitHub repo','https://github.com/microsoft/playwright'],
];

const b = await webkit.launch();
for (const [name, url] of sites) {
  const p = await b.newPage({ viewport:{width:1200,height:900} });
  // A real extension's content scripts are exempt from the page's CSP; the
  // harness injects into page context, so strip CSP to match extension reality.
  await p.route('**/*', async route => {
    const req = route.request();
    if (req.resourceType() !== 'document') return route.continue();
    try {
      const res = await route.fetch();
      const h = { ...res.headers() };
      delete h['content-security-policy'];
      delete h['content-security-policy-report-only'];
      return route.fulfill({ response: res, headers: h });
    } catch (e) { return route.continue(); }
  });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0,90)));
  try {
    await p.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
    await p.waitForTimeout(2500);   // let SPA content settle before scanning
    await p.addStyleTag({ content: css });
    for (const f of files) await p.addScriptTag({ content: f });
    await p.waitForFunction(() => !!window.MTT, null, {timeout:5000});

    const t0 = Date.now();
    await p.evaluate(() => window.MTT.blocks.translateVisible());
    await p.waitForFunction(() => {
      const all = document.querySelectorAll('.mtt-tr');
      return all.length > 0 && ![...all].some(n => n.classList.contains('pending'));
    }, null, {timeout:30000}).catch(()=>{});
    const ms = Date.now() - t0;

    const r = await p.evaluate(() => {
      const nodes = [...document.querySelectorAll('.mtt-tr')];
      return {
        n: nodes.length,
        batch: window.__mttCalls.translateBatch,
        hebrew: nodes.filter(x => /[֐-׿]/.test(x.textContent)).length,
        samples: nodes.slice(0,3).map(x => x.textContent.slice(0,60)),
        // did we damage the page? compare a stable structural signal
        layoutOk: document.body.scrollWidth <= window.innerWidth + 40
      };
    });
    console.log(`\n${name}  (${ms}ms)`);
    console.log(`  blocks=${r.n}  hebrew=${r.hebrew}  requests=${r.batch}  noHScroll=${r.layoutOk}`);
    r.samples.forEach(s => console.log(`    · ${s}`));
    if (errs.length) console.log(`  ⚠️ page errors: ${[...new Set(errs)].slice(0,2).join(' | ')}`);

    await p.evaluate(() => window.MTT.blocks.clearAll());
    await p.waitForTimeout(200);
    const left = await p.evaluate(() => document.querySelectorAll('.mtt-tr').length);
    console.log(`  cleanup: ${left === 0 ? '✅ page fully restored' : '❌ '+left+' nodes left'}`);
  } catch(e) { console.log(`\n${name}: ERR ${e.message.slice(0,120)}`); }
  await p.close();
}
await b.close();
