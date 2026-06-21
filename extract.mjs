// Extract a Claude Design bundle.html into a static site:
//   - assets/<id>.<ext> for each binary asset
//   - index.html with template content + UUID placeholders rewritten to assets/ paths
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const BUNDLE = path.join(ROOT, 'shout-party-landing.bundle.html');
const OUT = path.join(ROOT, 'docs');
const ASSETS = path.join(OUT, 'assets');
const STATIC = path.join(ROOT, 'static');

// Cloudflare Web Analytics beacon token. Free, cookieless (no consent banner
// needed), and the token is a PUBLIC client-side id — visible in page source —
// so committing it here is fine, not a secret. Get it at
// dash.cloudflare.com → Analytics & Logs → Web Analytics → add shoutparty.com.
// While left as the placeholder the beacon is skipped (build still succeeds);
// paste the real token to start collecting. Stats live in that same dashboard.
const CF_BEACON_TOKEN = 'f3acd520895f438fa812dc5c9db100d0';

// Built once and injected into every generated page (index.html + privacy.html)
// so all of shoutparty.com is tracked under the one hostname beacon. Empty while
// the token is the placeholder, so those pages ship without a broken <script>.
const cfBeacon = (CF_BEACON_TOKEN && CF_BEACON_TOKEN !== 'PASTE_TOKEN_HERE')
  ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${CF_BEACON_TOKEN}"}'></script>`
  : '';

const html = await readFile(BUNDLE, 'utf8');

function pickScript(type) {
  const re = new RegExp(`<script[^>]*type="${type}"[^>]*>([\\s\\S]*?)</script>`, 'i');
  const m = html.match(re);
  if (!m) throw new Error(`missing script type=${type}`);
  return m[1];
}

const manifest = JSON.parse(pickScript('__bundler/manifest'));
let template = JSON.parse(pickScript('__bundler/template'));

let extResources = [];
const extReMatch = html.match(/<script[^>]*type="__bundler\/ext_resources"[^>]*>([\s\S]*?)<\/script>/i);
if (extReMatch) extResources = JSON.parse(extReMatch[1]);

await rm(OUT, { recursive: true, force: true });
await mkdir(ASSETS, { recursive: true });

const mimeExt = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff2': 'woff2',
  'application/font-woff': 'woff',
  'text/css': 'css',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/html': 'html',
};

// --- Performance patch: particle canvas ------------------------------------
// The exported particle script sizes its canvas backing store to the full page
// height x devicePixelRatio^2, then clearRect()s and repaints that whole surface
// on every animation frame. On a Retina display over a long page that is a
// ~150-325 MB GPU texture cleared 60x/s — enough to pin the GPU and thermally
// throttle the machine. The canvas is `position: fixed; inset: 0`, so it only
// ever needs to cover the viewport. Patch the extracted asset (not docs/, which
// is regenerated) to: size to the viewport, cap DPR at 2, pause while the tab is
// hidden, and honour prefers-reduced-motion. Each replace asserts its anchor so
// a future bundle re-export that changes this script fails loudly here.
function patchParticleJs(src) {
  let js = src;
  const assertReplace = (from, to, label) => {
    if (!js.includes(from)) throw new Error(`particle JS patch: ${label} anchor not found — bundle script changed`);
    js = js.split(from).join(to);
  };

  // Honour reduced-motion: bail before any allocation or RAF loop.
  assertReplace(
    '  if (!canvas) return;\n',
    "  if (!canvas) return;\n  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;\n",
    'reduced-motion guard'
  );

  // Route every devicePixelRatio read through the capped `dpr` (declared next).
  js = js.split('window.devicePixelRatio').join('dpr');

  // Declare the capped dpr once. Inserted AFTER the global rewrite above so the
  // initialiser keeps the real `window.devicePixelRatio` read.
  assertReplace(
    '  let w = 0, h = 0, raf;\n',
    '  let w = 0, h = 0, raf;\n  const dpr = Math.min(window.devicePixelRatio || 1, 2);\n',
    'dpr declaration'
  );

  // Size the backing store to the viewport, not the whole scrollable document.
  assertReplace(
    '    h = canvas.height = Math.max(document.body.scrollHeight, window.innerHeight) * dpr;\n',
    '    h = canvas.height = window.innerHeight * dpr;\n',
    'canvas height'
  );
  assertReplace(
    "    canvas.style.height = Math.max(document.body.scrollHeight, window.innerHeight) + 'px';\n",
    "    canvas.style.height = window.innerHeight + 'px';\n",
    'canvas style height'
  );

  // Stop the RAF loop while the tab is hidden; restart it on return.
  assertReplace(
    '  resize();\n  tick();',
    "  document.addEventListener('visibilitychange', () => {\n    cancelAnimationFrame(raf);\n    if (!document.hidden) tick();\n  });\n  resize();\n  tick();",
    'visibility pause'
  );

  return js;
}

const uuidToPath = {};
let assetCount = 0;
let particlePatched = false;
for (const [uuid, entry] of Object.entries(manifest)) {
  let bytes = Buffer.from(entry.data, 'base64');
  if (entry.compressed) bytes = gunzipSync(bytes);
  const ext = mimeExt[entry.mime] || 'bin';
  if (ext === 'js' && bytes.toString('utf8').includes('// Particle field')) {
    bytes = Buffer.from(patchParticleJs(bytes.toString('utf8')), 'utf8');
    particlePatched = true;
  }
  const filename = `${uuid}.${ext}`;
  await writeFile(path.join(ASSETS, filename), bytes);
  uuidToPath[uuid] = `assets/${filename}`;
  assetCount++;
}
if (!particlePatched) throw new Error('particle JS asset (// Particle field) not found in bundle — perf patch did not apply');
console.log(`Wrote ${assetCount} assets`);

// Replace UUID placeholders in template with asset paths
for (const [uuid, p] of Object.entries(uuidToPath)) {
  template = template.split(uuid).join(p);
}

// Strip integrity/crossorigin attributes — same as the runtime does
template = template.replace(/\s+integrity="[^"]*"/gi, '').replace(/\s+crossorigin="[^"]*"/gi, '');

// Fonts are self-hosted (see assets/*.woff2); drop the leftover Google Fonts
// preconnect hints so the page opens no third-party connections.
template = template.replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.(?:googleapis|gstatic)\.com"[^>]*>/g, '');

// OFL 1.1 attribution for the self-hosted Manrope font. The license requires
// the copyright notice to ship alongside the Font Software; the comment is a
// human-readable pointer to the full license file (written below).
template = template.replace(
  '<style>/* cyrillic-ext */',
  '<style>/* Manrope © 2018 The Manrope Project Authors, SIL OFL 1.1 — see assets/Manrope-OFL.txt */\n/* cyrillic-ext */'
);

// --- SEO --------------------------------------------------------------------
// docs/ is regenerated from scratch on every run, so all SEO markup is applied
// here as template transforms (plus the file writes below) rather than being
// hand-edited into docs/index.html. Rationale: docs/site_seo_suggestions.md.

// Canonical + Open Graph + Twitter Card, injected after the description meta.
// og:image is the share card authored in static/og-image.svg and copied into
// docs/assets/ further down.
const DESC_META = '<meta name="description" content="Shout Party is the word-guessing party game for friends and family. Six game modes, 1,500 words per language, 29 languages. Free on Google Play. No ads, no accounts, plays offline.">';
if (!template.includes(DESC_META)) throw new Error('description meta not found — bundle head changed');
template = template.replace(DESC_META, DESC_META + `
<link rel="canonical" href="https://shoutparty.com/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Shout Party">
<meta property="og:title" content="Shout Party — The word-guessing party game">
<meta property="og:description" content="The word-guessing party game for friends and family. Six game modes, 1,500 words per language, 29 languages. Free on Google Play — no ads, no accounts, plays offline.">
<meta property="og:url" content="https://shoutparty.com/">
<meta property="og:image" content="https://shoutparty.com/assets/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Shout Party — neon party-game wordmark">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Shout Party — The word-guessing party game">
<meta name="twitter:description" content="Six game modes, 1,500 words per language, 29 languages. Free on Google Play — no ads, no accounts, plays offline.">
<meta name="twitter:image" content="https://shoutparty.com/assets/og-image.png">
<meta name="twitter:image:alt" content="Shout Party — neon party-game wordmark">`);

// Descriptive image alt text for the screenshot strip (was "Home", "Teams"…).
for (const [from, to] of [
  ['alt="Home"', 'alt="Shout Party home screen with game-mode selection"'],
  ['alt="Teams"', 'alt="Setting up teams in Shout Party"'],
  ['alt="Modes"', 'alt="Shout Party game-mode picker"'],
  ['alt="In-game"', 'alt="Shout Party in-game word card during a round"'],
  ['alt="Drawing"', 'alt="Draw and Act mode in Shout Party"'],
  ['alt="Round result"', 'alt="Shout Party round recap of words guessed and passed"'],
  ['alt="Game over"', 'alt="Shout Party final scoreboard"'],
  ['alt="Privacy"', 'alt="Shout Party privacy settings screen"'],
]) {
  if (!template.includes(from)) throw new Error(`alt text not found: ${from}`);
  template = template.replace(from, to);
}

// FAQ — visible accordion plus matching FAQPage JSON-LD. The Q&A pairs are
// defined once and drive both, so the structured data can't drift from copy.
const FAQ = [
  ['Is Shout Party free?',
   'Yes — Shout Party is free on Google Play. There are no ads and no in-app purchases.'],
  ['Do I need an internet connection to play?',
   'No. Shout Party plays fully offline after installation; the word decks live on your device.'],
  ['How many players do I need?',
   'Shout Party works with two or more teams, so it fits anything from a couple of friends to a full room.'],
  ['What languages does Shout Party support?',
   'It ships in 29 languages, each with its own 1,500-word deck — pick a language and the whole game follows.'],
  ['Do I need to create an account?',
   'No. There is no account, no sign-up and no personal data required to play.'],
  ['Is Shout Party suitable for families?',
   'Yes. The word list is family-friendly, so it suits game nights with family and friends.'],
  ['What is High Stakes mode?',
   'High Stakes is a simulated bet round: teams wager points they have already earned. No real money or real currency is involved.'],
];

const faqItems = FAQ.map(([q, a]) =>
  `      <details class="faq-item">\n        <summary>${q}</summary>\n        <p>${a}</p>\n      </details>`
).join('\n');
const faqSection = `
  <!-- FAQ -->
  <section id="faq">
    <div class="container">
      <div class="section-head reveal">
        <div class="section-eyebrow">Good to know</div>
        <h2 class="section-title">Questions, answered.</h2>
      </div>
      <div class="faq-list reveal">
${faqItems}
      </div>
    </div>
  </section>

`;
if (!template.includes('<footer class="footer">')) throw new Error('footer anchor not found');
template = template.replace('<footer class="footer">', faqSection + '<footer class="footer">');

// FAQ accordion styling, appended to the main stylesheet.
const SECTION_RULE = 'section { position: relative; z-index: 1; padding: 100px 0; }';
if (!template.includes(SECTION_RULE)) throw new Error('section CSS rule not found');
template = template.replace(SECTION_RULE, SECTION_RULE + `
.faq-list { max-width: 760px; margin: 52px auto 0; }
.faq-item { border-bottom: 1px solid var(--border); }
.faq-item summary { list-style: none; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 24px 4px; font-size: 18px; font-weight: 600; color: var(--text); }
.faq-item summary::-webkit-details-marker { display: none; }
.faq-item summary::after { content: "+"; color: var(--mint); font-size: 26px; font-weight: 400; line-height: 1; transition: transform 0.2s ease; }
.faq-item[open] summary::after { transform: rotate(45deg); }
.faq-item p { margin: -4px 4px 24px; color: var(--text-mute); font-size: 15px; line-height: 1.65; }
/* Official Play badge replaces the recreated button: strip the old chrome, show only the artwork. */
.gp-badge { background: none !important; border: 0 !important; padding: 0 !important; box-shadow: none !important; }
.gp-badge:hover { box-shadow: none !important; }
.gp-badge img { display: block; height: 62px; width: auto; }`);

// Structured data: MobileApplication + FAQPage, injected before </body>.
// No aggregateRating block — only add one with real Play Console numbers.
const appLd = {
  '@context': 'https://schema.org',
  '@type': 'MobileApplication',
  name: 'Shout Party',
  operatingSystem: 'Android',
  applicationCategory: 'GameApplication',
  applicationSubCategory: 'Party Game',
  url: 'https://shoutparty.com/',
  downloadUrl: 'https://play.google.com/store/apps/details?id=com.sepulka.shoutparty',
  description: 'Shout Party is the word-guessing party game for friends and family. Six game modes, 1,500 words per language, 29 languages. Free, offline, no ads, no accounts.',
  inLanguage: ['en','ru','uk','de','fr','es','it','pl','pt','nl','cs','sk','hu','ro','bg','hr','sr','sv','da','no','fi','tr','he','hi','id','zh','ja','ko','ar'],
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  publisher: { '@type': 'Organization', name: 'SEPULKA S.R.L.' },
};
const faqLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map(([q, a]) => ({
    '@type': 'Question',
    name: q,
    acceptedAnswer: { '@type': 'Answer', text: a },
  })),
};
// Escape any "</" so the JSON can't break out of the <script> element.
const ldScript = (obj) =>
  `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2).split('</').join('<\\/')}\n</script>`;
template = template.replace('</body></html>',
  `${ldScript(appLd)}\n${ldScript(faqLd)}\n</body></html>`);

// Build __resources object so any code reading window.__resources still works.
const resourceMap = {};
for (const e of extResources) {
  if (uuidToPath[e.uuid]) resourceMap[e.id] = uuidToPath[e.uuid];
}
const resourceScript = `<script>window.__resources = ${JSON.stringify(resourceMap).split('</script>').join('<\\/script>')};</script>`;
template = template.replace(/<head[^>]*>/i, (m) => m + resourceScript);

// Wire Play Store CTAs. The generated bundle uses href="#" / href="#download"
// for the three Google Play buttons; point them all at the live listing.
// UTM via the Play `referrer` param so Play Console acquisition reports attribute
// installs that came from the site; utm_content marks which CTA placement converted.
const playUrl = (content) => {
  const utm = `utm_source=shoutparty.com&utm_medium=referral&utm_campaign=landing&utm_content=${content}`;
  return `https://play.google.com/store/apps/details?id=com.sepulka.shoutparty&referrer=${encodeURIComponent(utm)}`;
};
template = template
  .replace(
    '<a class="nav-cta" href="#download" aria-label="Get on Google Play">',
    `<a class="nav-cta" href="${playUrl('nav')}" target="_blank" rel="noopener" aria-label="Get on Google Play">`
  )
  // Swap the recreated Play badge (custom-coloured wedge + "Google Play" text —
  // against Google's brand guidelines, which require the official artwork) for
  // Google's official badge image. Both badge instances share identical markup,
  // so one global replace of the whole <a>…</a> element covers them.
  .replace(
    /<a class="gp-badge"[\s\S]*?<\/a>/g,
    `<a class="gp-badge" href="${playUrl('badge')}" target="_blank" rel="noopener">` +
      `<img src="assets/google-play-badge.png" alt="Get it on Google Play" width="160" height="62"></a>`
  )
  // Drop the exact app-size claim — package may change. Keep the "small download" vibe.
  .replace('<span>~3.7 MB</span>', '<span>Tiny download</span>')
  // .nav-inner is on the same element as .container; its shorthand `padding: 18px 0`
  // overrides .container's horizontal padding, so the header sits flush to the
  // screen edge on mobile. Use longhand to preserve container padding.
  .replace(
    /\.nav-inner \{\s*display: flex;\s*align-items: center;\s*justify-content: space-between;\s*padding: 18px 0;\s*\}/,
    '.nav-inner {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding-top: 18px;\n  padding-bottom: 18px;\n}'
  )
  // Hide the sticky nav on phones — the hero already exposes the logo + Play
  // Store CTA, so the header is redundant and eats vertical space.
  .replace(
    '@media (max-width: 560px) {',
    '@media (max-width: 720px) {\n  .nav { display: none; }\n}\n@media (max-width: 560px) {'
  )
  // Operator identification line (Romanian Law 365/2002): full legal entity,
  // city/country, CUI (fiscal code), and contact email — required for EU
  // commercial operators identifying themselves to consumers. The Privacy link
  // points at the site's own analytics disclosure (docs/privacy.html, generated
  // below) — distinct from the app's policy at sepulka.cc/shoutparty/privacy.html. Second
  // line is Google's required attribution for referencing the Play brand/badge.
  .replace(
    '© 2026 Sepulka</div>',
    '© 2026 SEPULKA S.R.L. · Bucharest, Romania · CUI 50254340 · <a href="mailto:contact@sepulka.cc">contact@sepulka.cc</a> · <a href="/privacy">Privacy</a>' +
      '<br>Google Play and the Google Play logo are trademarks of Google LLC.</div>'
  );

// Cloudflare Web Analytics: inject the cookieless beacon before </body>. Skipped
// (with a warning) until CF_BEACON_TOKEN is filled in, so the build never ships a
// broken <script> with a placeholder token. privacy.html gets the same beacon
// further down, so the whole site reports under the one hostname.
if (cfBeacon) {
  if (!template.includes('</body></html>')) throw new Error('analytics: </body></html> anchor not found');
  template = template.replace('</body></html>', cfBeacon + '\n</body></html>');
  console.log('Injected Cloudflare Web Analytics beacon');
} else {
  console.warn('Cloudflare Web Analytics: CF_BEACON_TOKEN not set — beacon NOT injected');
}

await writeFile(path.join(OUT, 'index.html'), template);

// Manrope OFL 1.1 license text. Required to accompany the redistributed
// .woff2 files in assets/. Source: github.com/davelab6/manrope/license.txt
const MANROPE_OFL = `Copyright 2018 The Manrope Project Authors (https://github.com/sharanda/manrope), with Reserved Font Name “Manrope”.

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
`;
await writeFile(path.join(ASSETS, 'Manrope-OFL.txt'), MANROPE_OFL);

// Hand-authored social share card (static/og-image.svg → .png). docs/ is wiped
// each run, so the committed PNG is copied in from static/ rather than living
// under docs/ directly.
await copyFile(path.join(STATIC, 'og-image.png'), path.join(ASSETS, 'og-image.png'));

// Official "Get it on Google Play" badge artwork (Google brand guidelines require
// the official badge, not a recreation). Committed in static/, copied in like
// og-image because docs/ is wiped each run.
await copyFile(path.join(STATIC, 'google-play-badge.png'), path.join(ASSETS, 'google-play-badge.png'));

// Crawl directives. sitemap <lastmod> is refreshed to the build date each run.
const today = new Date().toISOString().slice(0, 10);

// Site privacy notice. This covers shoutparty.com itself (the only personal-data
// processing the *website* does is Cloudflare Web Analytics) — separate from the
// Shout Party *app's* policy at sepulka.cc/shoutparty/privacy.html. Cloudflare Web Analytics
// is cookieless, so no consent banner is owed; this page satisfies the GDPR
// Art. 13 transparency duty that applies regardless of consent. Self-contained
// (brand palette inline, no font/asset deps) so it renders even though docs/ is
// wiped each run and it shares none of index.html's hashed assets.
const prettyDate = new Date(today + 'T00:00:00Z').toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});
const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy — Shout Party</title>
<meta name="description" content="Privacy notice for the shoutparty.com website: what the site measures with Cloudflare Web Analytics, and why no cookies or consent banner are used.">
<link rel="canonical" href="https://shoutparty.com/privacy">
<meta name="robots" content="index, follow">
<style>
:root { --bg: #0A0A0F; --text: #F4F4F8; --text-mute: #9A9AA8; --text-dim: #6A6A7A; --mint: #3FE5C2; --border: rgba(255, 255, 255, 0.08); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text-mute); line-height: 1.7; -webkit-font-smoothing: antialiased; font-family: 'Manrope', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
.wrap { max-width: 720px; margin: 0 auto; padding: 72px 24px 120px; }
a { color: var(--mint); text-decoration: none; }
a:hover { text-decoration: underline; }
.back { display: inline-block; margin-bottom: 44px; font-weight: 600; }
h1 { color: var(--text); font-size: 34px; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 8px; }
h2 { color: var(--text); font-size: 20px; font-weight: 700; margin: 40px 0 12px; }
p, li { font-size: 16px; }
ul { padding-left: 22px; }
li { margin: 6px 0; }
hr { border: 0; border-top: 1px solid var(--border); margin: 48px 0; }
.muted { color: var(--text-dim); font-size: 14px; }
</style>
</head>
<body>
<div class="wrap">
<a class="back" href="/">← Back to Shout Party</a>
<h1>Website privacy notice</h1>
<p class="muted">Last updated ${prettyDate}</p>

<p>This notice explains how the <strong>shoutparty.com</strong> website handles your data. It covers the website only. The Shout Party Android app has its own privacy policy at <a href="https://sepulka.cc/shoutparty/privacy.html" rel="noopener">sepulka.cc/shoutparty/privacy.html</a>.</p>

<h2>What we measure</h2>
<p>We use <strong>Cloudflare Web Analytics</strong> to understand, in aggregate, how the site is used and how it performs. It records page views, the referring site, and basic page-load timings, plus an approximate country (derived from your IP address) and your device type, browser and operating system (derived from your browser's user-agent). It does <strong>not</strong> build a profile of you, track you across other sites, or store your IP address to identify you.</p>

<h2>Cookies</h2>
<p>None. Cloudflare Web Analytics is cookieless and stores nothing on your device, which is why this site shows no cookie-consent banner.</p>

<h2>Legal basis</h2>
<p>Processing rests on our legitimate interest (Art. 6(1)(f) GDPR) in measuring and improving the website. Because the data is aggregate and not used to identify you, your interests are not overridden.</p>

<h2>Who processes the data</h2>
<p>Cloudflare, Inc. provides the analytics as our processor. See Cloudflare's <a href="https://www.cloudflare.com/privacypolicy/" rel="noopener">privacy policy</a> and its <a href="https://www.cloudflare.com/web-analytics/" rel="noopener">Web Analytics</a> page for details on how it handles the data.</p>

<h2>Your rights</h2>
<p>Under the GDPR you may request access, rectification, erasure, restriction or objection regarding your personal data. Because this site's analytics are aggregate and cookieless we hold no record tied to you individually, but you are welcome to contact us with any question at <a href="mailto:contact@sepulka.cc">contact@sepulka.cc</a>.</p>

<hr>
<p class="muted">Operator: SEPULKA S.R.L. · Bucharest, Romania · CUI 50254340 · <a href="mailto:contact@sepulka.cc">contact@sepulka.cc</a></p>
</div>
${cfBeacon}
</body>
</html>
`;
await writeFile(path.join(OUT, 'privacy.html'), PRIVACY_HTML);

await writeFile(path.join(OUT, 'robots.txt'),
  'User-agent: *\nAllow: /\n\nSitemap: https://shoutparty.com/sitemap.xml\n');
await writeFile(path.join(OUT, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  '  <url>\n' +
  '    <loc>https://shoutparty.com/</loc>\n' +
  `    <lastmod>${today}</lastmod>\n` +
  '    <changefreq>monthly</changefreq>\n' +
  '    <priority>1.0</priority>\n' +
  '  </url>\n' +
  '  <url>\n' +
  '    <loc>https://shoutparty.com/privacy</loc>\n' +
  `    <lastmod>${today}</lastmod>\n` +
  '    <changefreq>yearly</changefreq>\n' +
  '    <priority>0.3</priority>\n' +
  '  </url>\n' +
  '</urlset>\n');

// GitHub Pages: custom domain + skip Jekyll processing.
await writeFile(path.join(OUT, 'CNAME'), 'shoutparty.com\n');
await writeFile(path.join(OUT, '.nojekyll'), '');

console.log('Wrote docs/index.html, og-image, robots.txt, sitemap.xml, CNAME, .nojekyll');
