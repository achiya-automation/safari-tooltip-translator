// Behavioural check for the extension's content scripts under real WebKit.
// Run: node test/run.mjs
import { webkit } from '/opt/homebrew/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('file://' + join(here, 'harness.html'));
await page.waitForFunction(() => !!window.MTT, null, { timeout: 5000 });

console.log('\n── boot ──');
ok('content.js exposed window.MTT', await page.evaluate(() => !!window.MTT));
ok('blocks.js attached', await page.evaluate(() => !!(window.MTT && window.MTT.blocks)));
ok('captions.js attached', await page.evaluate(() => !!(window.MTT && window.MTT.captions)));
ok('no page errors on load', errors.length === 0, errors.join(' | '));

// ── The bug that made the extension look dead: four listener registrations meant
//    every toggle fired an even number of times and cancelled itself out.
console.log('\n── keyboard toggles fire exactly once ──');
const beforeEnabled = await page.evaluate(() => window.MTT.CONFIG.enabled);
await page.keyboard.down('Alt');
await page.keyboard.press('t');
await page.keyboard.up('Alt');
await page.waitForTimeout(120);
const afterEnabled = await page.evaluate(() => window.MTT.CONFIG.enabled);
ok('Alt+T actually flips enabled', beforeEnabled !== afterEnabled, `${beforeEnabled} → ${afterEnabled}`);

await page.keyboard.down('Alt');
await page.keyboard.press('t');
await page.keyboard.up('Alt');
await page.waitForTimeout(120);
ok('Alt+T flips back', await page.evaluate(() => window.MTT.CONFIG.enabled) === beforeEnabled);

const wordBefore = await page.evaluate(() => window.MTT.CONFIG.wordMode);
await page.keyboard.press('F8');
await page.waitForTimeout(120);
ok('F8 flips wordMode', await page.evaluate(() => window.MTT.CONFIG.wordMode) !== wordBefore);
await page.keyboard.press('F8');
await page.waitForTimeout(120);

console.log('\n── block detection ──');
const blockTests = await page.evaluate(() => {
  const f = window.MTT.blocks.findBlock;
  return {
    fromInnerSpan: f(document.getElementById('inner'))?.id,
    fromParagraph: f(document.getElementById('p1'))?.id,
    fromListItem:  f(document.getElementById('li1'))?.id
  };
});
ok('nested <span> resolves to its paragraph', blockTests.fromInnerSpan === 'deep', blockTests.fromInnerSpan);
ok('paragraph resolves to itself', blockTests.fromParagraph === 'p1', blockTests.fromParagraph);
ok('list item resolves to itself', blockTests.fromListItem === 'li1', blockTests.fromListItem);

console.log('\n── translate one paragraph in place ──');
await page.evaluate(() => window.MTT.blocks.toggleBlock(document.getElementById('p1')));
await page.waitForFunction(() => {
  const n = document.querySelector('#p1 > .mtt-tr');
  return n && !n.classList.contains('pending') && n.textContent.length > 3;
}, null, { timeout: 15000 }).catch(() => {});
const p1 = await page.evaluate(() => {
  const n = document.querySelector('#p1 > .mtt-tr');
  return { text: n ? n.textContent : null, dir: n ? n.getAttribute('dir') : null,
           original: document.getElementById('p1').firstChild.textContent.trim() };
});
ok('translation node added under the paragraph', !!p1.text, JSON.stringify(p1));
ok('translation is Hebrew', /[֐-׿]/.test(p1.text || ''), p1.text);
ok('marked rtl', p1.dir === 'rtl', p1.dir);
ok('original text untouched', p1.original.startsWith('Every evening'), p1.original);

console.log('\n── toggling the same paragraph removes it ──');
await page.evaluate(() => window.MTT.blocks.toggleBlock(document.getElementById('p1')));
await page.waitForTimeout(200);
ok('translation removed on second click', await page.evaluate(() => !document.querySelector('#p1 > .mtt-tr')));

console.log('\n── translate everything visible, in ONE request ──');
await page.evaluate(() => { window.__mttCalls.translateBatch = 0; window.__mttCalls.translate = 0; });
await page.evaluate(() => window.MTT.blocks.translateVisible());
await page.waitForFunction(() => document.querySelectorAll('.mtt-tr:not(.pending)').length >= 4,
  null, { timeout: 20000 }).catch(() => {});
const vis = await page.evaluate(() => ({
  count: document.querySelectorAll('.mtt-tr').length,
  batchCalls: window.__mttCalls.translateBatch,
  singleCalls: window.__mttCalls.translate,
  hebrewSkipped: !document.querySelector('#heb > .mtt-tr'),
  hebrewIntact: document.getElementById('heb').textContent.trim()
}));
ok('several blocks translated', vis.count >= 4, 'count=' + vis.count);
ok('batched into a single request', vis.batchCalls === 1, 'batch=' + vis.batchCalls + ' single=' + vis.singleCalls);
ok('Hebrew paragraph left alone', vis.hebrewSkipped, vis.hebrewIntact);

console.log('\n── clear all ──');
await page.evaluate(() => window.MTT.blocks.clearAll());
await page.waitForTimeout(150);
ok('every translation removed', await page.evaluate(() => document.querySelectorAll('.mtt-tr').length === 0));
ok('page text restored', await page.evaluate(() =>
  document.getElementById('p1').textContent.trim() === 'Every evening he climbed the spiral staircase to light the lamp.'));

console.log('\n── caching: a repeat never hits the network ──');
await page.evaluate(() => { window.__mttCalls.translateBatch = 0; });
await page.evaluate(() => window.MTT.blocks.toggleBlock(document.getElementById('p2')));
await page.waitForFunction(() => {
  const n = document.querySelector('#p2 > .mtt-tr');
  return n && !n.classList.contains('pending');
}, null, { timeout: 15000 }).catch(() => {});
ok('cached block needs no new request', await page.evaluate(() => window.__mttCalls.translateBatch === 0),
   'batch=' + await page.evaluate(() => window.__mttCalls.translateBatch));

console.log('\n── selection translates immediately (no button) ──');
await page.evaluate(() => window.MTT.blocks.clearAll());
const p3box = await page.evaluate(() => {
  const r = document.getElementById('p3').getBoundingClientRect();
  return { x1: r.left + 5, y: r.top + r.height / 2, x2: r.left + Math.min(220, r.width - 10) };
});
await page.mouse.move(p3box.x1, p3box.y);
await page.mouse.down();
await page.mouse.move(p3box.x2, p3box.y, { steps: 8 });
await page.mouse.up();
await page.waitForFunction(() => document.getElementById('mtt-tip').classList.contains('v'),
  null, { timeout: 15000 }).catch(() => {});
ok('selection shows a translated tooltip at once', await page.evaluate(() => {
  const t = document.getElementById('mtt-tip');
  return t.classList.contains('v') && /[\u0590-\u05FF]/.test(t.textContent);
}));
ok('no leftover translate button in the DOM',
   await page.evaluate(() => !document.getElementById('mtt-sel')));
await page.evaluate(() => window.getSelection().removeAllRanges());
await page.mouse.move(5, 5);
await page.waitForTimeout(400);

console.log('\n── hover modes ──');
await page.evaluate(() => { window.MTT.CONFIG.hoverMode = 'off'; });
await page.mouse.move(200, 200);
await page.mouse.move(340, 165);
await page.waitForTimeout(900);
ok('hoverMode "off" shows nothing',
   await page.evaluate(() => !document.getElementById('mtt-tip').classList.contains('v')));

await page.evaluate(() => { window.MTT.CONFIG.hoverMode = 'always'; window.MTT.CONFIG.tooltipDelay = 150; });
const box = await page.evaluate(() => { const r = document.getElementById('p3').getBoundingClientRect();
  return { x: r.left + 40, y: r.top + r.height / 2 }; });
await page.mouse.move(box.x - 60, box.y);
await page.mouse.move(box.x, box.y);
await page.waitForFunction(() => document.getElementById('mtt-tip').classList.contains('v'),
  null, { timeout: 12000 }).catch(() => {});
ok('tooltip appears on hover',
   await page.evaluate(() => document.getElementById('mtt-tip').classList.contains('v')));

// The old build called hide() on every single mousemove, so the tooltip vanished
// the instant the pointer twitched.
await page.mouse.move(box.x + 6, box.y + 3);
await page.waitForTimeout(80);
ok('tooltip survives small pointer movement',
   await page.evaluate(() => document.getElementById('mtt-tip').classList.contains('v')));

await page.mouse.move(5, 5);
await page.waitForTimeout(600);
ok('tooltip hides when the pointer leaves the text',
   await page.evaluate(() => !document.getElementById('mtt-tip').classList.contains('v')));

console.log('\n── caption track ──');
await page.evaluate(() => window.MTT.captions.enable());
await page.waitForTimeout(500);
const capReady = await page.waitForFunction(() => {
  const o = document.querySelector('.mtt-cap');
  return !!o;
}, null, { timeout: 8000 }).then(() => true).catch(() => false);
ok('caption overlay created', capReady);
const trackState = await page.evaluate(() => {
  const v = document.getElementById('vid');
  return { tracks: v.textTracks.length, mode: v.textTracks[0] && v.textTracks[0].mode,
           cues: v.textTracks[0] && v.textTracks[0].cues ? v.textTracks[0].cues.length : 0 };
});
ok('subtitle track discovered with cues', trackState.tracks > 0 && trackState.cues > 0, JSON.stringify(trackState));

console.log('\n── iframe observer does not spin ──');
const churn = await page.evaluate(async () => {
  const before = performance.now();
  const host = document.createElement('div');
  document.body.appendChild(host);
  for (let i = 0; i < 3000; i++) {
    const d = document.createElement('div');
    d.textContent = 'x' + i;
    host.appendChild(d);
    if (i % 100 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const elapsed = performance.now() - before;
  host.remove();
  return elapsed;
});
ok('3000 DOM insertions stay fast (no rescan storm)', churn < 4000, churn.toFixed(0) + 'ms');

ok('still no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
