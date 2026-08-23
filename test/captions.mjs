import { webkit } from '/opt/homebrew/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const b = await webkit.launch();
const p = await b.newPage({ viewport:{width:900,height:700} });
p.on('pageerror', e => console.log('  PAGEERR', String(e).slice(0,120)));
await p.goto('file:///Users/am/safari-tooltip-translator/test/harness.html');
await p.waitForFunction(() => !!window.MTT);
await p.evaluate(() => window.MTT.captions.enable());
// let the cue list get pre-translated
await p.waitForTimeout(4000);
const primed = await p.evaluate(() => {
  const v = document.getElementById('vid');
  const t = v.textTracks[0];
  t.mode = 'hidden';
  return { mode: t.mode, cues: t.cues.length };
});
console.log('track:', JSON.stringify(primed));
await p.evaluate(async () => {
  const v = document.getElementById('vid');
  v.muted = true;
  v.currentTime = 0.3;
  await v.play().catch(e => console.log('play err', e.name));
});
const seen = [];
for (let i = 0; i < 14; i++) {
  await p.waitForTimeout(450);
  const s = await p.evaluate(() => {
    const o = document.querySelector('.mtt-cap');
    const v = document.getElementById('vid');
    return { t: +v.currentTime.toFixed(1), vis: o && o.classList.contains('v'), text: o ? o.textContent : '' };
  });
  if (s.vis && s.text && !seen.includes(s.text)) { seen.push(s.text); console.log(`  t=${s.t}s → ${s.text}`); }
}
console.log(seen.length ? `\n✅ ${seen.length} translated caption lines rendered during playback`
                        : '\n❌ no captions rendered');
await b.close();
