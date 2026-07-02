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

// --- Localization -----------------------------------------------------------
// The app ships in 29 languages; the homepage is English. We generate a
// standalone localized landing page per non-English language at /<code>/, built
// entirely from the Play-Console-approved store-listing copy (l10n/listings.json,
// parsed from the app repo's docs/store_listings/*.md). Every translated string
// is reused verbatim — structure is derived only from the language-independent
// ✦ (section) and • (bullet) markers, so no copy is machine-translated or altered.
// hreflang stitches all locales together (English homepage = en + x-default).
const LISTINGS = JSON.parse(await readFile(path.join(ROOT, 'l10n', 'listings.json'), 'utf8'));
const LOCALES = ['en', 'ru', 'uk', 'de', 'fr', 'es', 'it', 'pl', 'pt', 'nl', 'cs', 'sk', 'hu', 'ro', 'bg', 'hr', 'sr', 'sv', 'da', 'no', 'fi', 'tr', 'he', 'hi', 'id', 'zh', 'ja', 'ko', 'ar'];
const RTL = new Set(['ar', 'he']);
// og:locale needs language_TERRITORY; map each to the app's default territory.
const OG_LOCALE = {
  en: 'en_US', ru: 'ru_RU', uk: 'uk_UA', de: 'de_DE', fr: 'fr_FR', es: 'es_ES', it: 'it_IT',
  pl: 'pl_PL', pt: 'pt_PT', nl: 'nl_NL', cs: 'cs_CZ', sk: 'sk_SK', hu: 'hu_HU', ro: 'ro_RO',
  bg: 'bg_BG', hr: 'hr_HR', sr: 'sr_RS', sv: 'sv_SE', da: 'da_DK', no: 'nb_NO', fi: 'fi_FI',
  tr: 'tr_TR', he: 'he_IL', hi: 'hi_IN', id: 'id_ID', zh: 'zh_CN', ja: 'ja_JP', ko: 'ko_KR', ar: 'ar_AR',
};
// Localized label for the header Play button ("Get the app"), in each locale's
// own script/territory (pt = European, zh = Simplified, sr = Cyrillic). Used as
// both the visible text and the link's accessible name.
const CTA_LABEL = {
  ru: 'Установить приложение', uk: 'Встановити застосунок', de: 'App herunterladen',
  fr: "Télécharger l'appli", es: 'Descargar la app', it: "Scarica l'app", pl: 'Pobierz aplikację',
  pt: 'Transferir a app', nl: 'App downloaden', cs: 'Stáhnout aplikaci', sk: 'Stiahnuť aplikáciu',
  hu: 'Alkalmazás letöltése', ro: 'Descarcă aplicația', bg: 'Изтегли приложението',
  hr: 'Preuzmi aplikaciju', sr: 'Преузми апликацију', sv: 'Hämta appen', da: 'Hent appen',
  no: 'Last ned appen', fi: 'Lataa sovellus', tr: 'Uygulamayı indir', he: 'הורדת האפליקציה',
  hi: 'ऐप डाउनलोड करें', id: 'Unduh aplikasi', zh: '下载应用', ja: 'アプリをダウンロード',
  ko: '앱 다운로드', ar: 'تنزيل التطبيق',
};
// Home URL for a locale: English lives at the site root, others at /<code>/.
const localeUrl = (code) => (code === 'en' ? 'https://shoutparty.com/' : `https://shoutparty.com/${code}/`);
// Reciprocal hreflang set — identical (self-referencing) on every page, per spec.
const hreflangSet = [
  ...LOCALES.map((c) => `<link rel="alternate" hreflang="${c}" href="${localeUrl(c)}">`),
  '<link rel="alternate" hreflang="x-default" href="https://shoutparty.com/">',
].join('\n');

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
<meta name="twitter:image:alt" content="Shout Party — neon party-game wordmark">
${hreflangSet}`);

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
    '<a href="/how-to-play-charades">How to play charades</a> · <a href="/charades-words">Charades words</a><br>' +
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

// --- SEO content pages ------------------------------------------------------
// Long-tail organic-search pages (charades how-to + word lists). Authored the
// same way as privacy.html: self-contained HTML (brand palette inline, no shared
// hashed assets) written straight to docs/, so they survive the docs/ wipe and
// don't depend on the design bundle. Each carries its own canonical/OG/JSON-LD
// and a Play CTA with a per-page utm_content tag. Registered in sitemap.xml and
// linked from the homepage footer below.
const CONTENT_CSS = `
:root { --bg: #0A0A0F; --surface: #161624; --text: #F4F4F8; --text-mute: #9A9AA8; --text-dim: #6A6A7A; --mint: #3FE5C2; --orange: #FF7A4D; --orange-light: #FFB89A; --peach: #F7C59F; --gold: #FFD166; --border: rgba(255,255,255,0.08); --gradient-shout: linear-gradient(90deg, #FF7A4D 0%, #FFB89A 100%); --gradient-party: linear-gradient(90deg, #3FE5C2 0%, #5AF0D2 100%); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text-mute); line-height: 1.7; -webkit-font-smoothing: antialiased; font-family: 'Manrope', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
a { color: var(--mint); text-decoration: none; }
a:hover { text-decoration: underline; }
.logo:hover, .cta-badge:hover { text-decoration: none; }
.wrap { max-width: 820px; margin: 0 auto; padding: 0 24px; }
header.site { position: sticky; top: 0; z-index: 50; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); background: rgba(10, 10, 15, 0.7); border-bottom: 1px solid var(--border); }
header.site .wrap { display: flex; align-items: center; justify-content: space-between; padding-top: 18px; padding-bottom: 18px; }
.logo { display: inline-flex; align-items: baseline; gap: 8px; font-weight: 800; letter-spacing: 0.04em; }
.logo .shout { font-size: 22px; background: var(--gradient-shout); -webkit-background-clip: text; background-clip: text; color: transparent; }
.logo .party { font-size: 14px; color: var(--mint); letter-spacing: 0.2em; }
.nav-cta { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; background: var(--orange); color: #1A0A04; border-radius: 999px; font-weight: 700; font-size: 14px; transition: transform 0.15s ease, box-shadow 0.15s ease; }
.nav-cta:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(255, 122, 77, 0.35); text-decoration: none; }
main { padding: 56px 0 24px; }
h1 { color: var(--text); font-size: clamp(30px, 6vw, 44px); font-weight: 800; letter-spacing: -0.02em; line-height: 1.12; margin: 0 0 20px; }
h2 { color: var(--text); font-size: 25px; font-weight: 700; letter-spacing: -0.01em; margin: 48px 0 14px; }
h3 { color: var(--text); font-size: 19px; font-weight: 700; margin: 30px 0 10px; }
p, li { font-size: 17px; }
.lead { font-size: 20px; color: var(--text); line-height: 1.6; }
ul, ol { padding-left: 22px; }
li { margin: 8px 0; }
strong { color: var(--text); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 4px; }
.chip { display: inline-block; padding: 7px 14px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text); font-size: 15px; font-weight: 600; }
.note { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--mint); border-radius: 12px; padding: 18px 20px; margin: 22px 0; }
.note p { margin: 0; }
.cta { text-align: center; background: linear-gradient(135deg, rgba(255,107,53,0.10), rgba(63,229,194,0.10)); border: 1px solid var(--border); border-radius: 20px; padding: 40px 28px; margin: 56px 0 8px; }
.cta h2 { margin-top: 0; }
.cta p { max-width: 520px; margin: 0 auto 22px; color: var(--text-mute); }
.cta-badge img { display: inline-block; height: 62px; width: auto; }
footer.site { border-top: 1px solid var(--border); margin-top: 64px; padding: 36px 0; font-size: 13px; color: var(--text-dim); }
.footer-inner { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; }
.footer-inner a { color: inherit; }
.footer-inner a:hover { color: var(--text); text-decoration: none; }
`;

// One word chip per entry.
const chips = (words) =>
  `<div class="chips">${words.map((w) => `<span class="chip">${w}</span>`).join('')}</div>`;

// Escape for use in HTML text/attributes. h1/title/description are authored as
// plain text (so the JSON-LD below carries clean strings) and escaped here where
// they land in markup.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Header Play button — matches the homepage nav CTA (orange pill, play-triangle
// icon + "Get the app"). `cta` is the utm_content tag threaded into the Play URL.
const playIcon = '<svg width="14" height="16" viewBox="0 0 14 16" fill="none" aria-hidden="true"><path d="M1 1.2v13.6c0 .5.5.8.9.6L13 8.6c.4-.2.4-.8 0-1L1.9.6C1.5.4 1 .7 1 1.2z" fill="currentColor"></path></svg>';
const navCta = (cta, label = 'Get the app') =>
  `<a class="nav-cta" href="${playUrl(cta)}" target="_blank" rel="noopener" aria-label="${esc(label)}">${playIcon} ${esc(label)}</a>`;

// Full self-contained content page. `cta` is the utm_content tag for the Play CTA.
function contentPage({ slug, title, description, h1, cta, jsonLd, body }) {
  const url = `https://shoutparty.com/${slug}`;
  const [t, d, h] = [esc(title), esc(description), esc(h1)];
  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Shout Party', item: 'https://shoutparty.com/' },
        { '@type': 'ListItem', position: 2, name: h1, item: url },
      ],
    },
    jsonLd,
  ];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Shout Party">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="https://shoutparty.com/assets/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="https://shoutparty.com/assets/og-image.png">
<style>${CONTENT_CSS}</style>
${ld.map((o) => ldScript(o)).join('\n')}
</head>
<body>
<header class="site">
  <div class="wrap">
    <a class="logo" href="/"><span class="shout">SHOUT</span><span class="party">PARTY</span></a>
    ${navCta(cta)}
  </div>
</header>
<main>
  <div class="wrap">
    <h1>${h}</h1>
${body}
    <div class="cta">
      <h2>Play it hands-free</h2>
      <p>Shout Party deals the words, runs the timer and keeps score for you — 1,500 words per language across 29 languages, six game modes, no ads, no accounts, and it plays fully offline. Free on Google Play.</p>
      <a class="cta-badge" href="${playUrl(cta)}" target="_blank" rel="noopener"><img src="/assets/google-play-badge.png" alt="Get it on Google Play" width="160" height="62"></a>
    </div>
  </div>
</main>
<footer class="site">
  <div class="wrap footer-inner">
    <div class="logo"><span class="shout">SHOUT</span><span class="party">PARTY</span></div>
    <div><a href="/how-to-play-charades">How to play charades</a> · <a href="/charades-words">Charades words</a><br>© 2026 SEPULKA S.R.L. · Bucharest, Romania · CUI 50254340 · <a href="mailto:contact@sepulka.cc">contact@sepulka.cc</a> · <a href="/privacy">Privacy</a><br>Google Play and the Google Play logo are trademarks of Google LLC.</div>
  </div>
</footer>
${cfBeacon}
</body>
</html>
`;
}

// --- Page: How to play charades --------------------------------------------
const howToBody = `
    <p class="lead">Charades is the classic no-equipment party game: one player acts out a word or phrase in total silence while their team races the clock to guess it. Here is everything you need to run a great game — the rules, the classic hand signals, the most popular variations, and a few tips to keep the whole room laughing.</p>

    <h2>What you need</h2>
    <ul>
      <li><strong>Four or more players</strong>, split into two teams (it scales happily to a big group).</li>
      <li><strong>A list of words</strong> to act out — grab some from our <a href="/charades-words">charades words list</a>, or let an app deal them so nobody sees the answers in advance.</li>
      <li><strong>A timer</strong> — one minute per turn is the classic setting.</li>
      <li>Something to keep score — a scrap of paper or your phone.</li>
    </ul>

    <h2>The basic rules, step by step</h2>
    <ol>
      <li><strong>Split into two teams.</strong> Each team takes turns sending one player up to act.</li>
      <li><strong>The actor draws a word</strong> in secret — the opposing team, an app, or a bowl of folded slips picks it so their own team cannot see it.</li>
      <li><strong>Start the timer</strong> and act it out <strong>in silence</strong>. No talking, no mouthing words, no pointing at objects in the room.</li>
      <li><strong>The actor's team shouts guesses</strong> until they get it or the minute runs out.</li>
      <li><strong>Score a point</strong> for every word guessed in time, then pass play to the other team.</li>
      <li><strong>Keep rotating actors</strong> so everyone gets a turn. Most points after an agreed number of rounds wins.</li>
    </ol>

    <h2>Classic charades hand signals</h2>
    <p>Before acting, players use a shared set of silent signals to frame the clue. These are worth agreeing on up front:</p>
    <ul>
      <li><strong>Number of words</strong> — hold up fingers for how many words are in the phrase.</li>
      <li><strong>Which word</strong> — hold up fingers again to show which word you are about to act (word one, word two…).</li>
      <li><strong>Number of syllables</strong> — tap that many fingers on your forearm.</li>
      <li><strong>"Sounds like"</strong> — cup a hand behind your ear.</li>
      <li><strong>"Whole thing"</strong> — sweep your arms in a big circle to signal you are acting the entire phrase at once.</li>
      <li><strong>"Close!"</strong> — wave a hand to pull guessers toward a nearly-right answer.</li>
    </ul>

    <h2>Popular charades variations</h2>
    <p>Half the fun is bending the rules. These are the variations groups reach for most — each one is also a built-in mode in Shout Party:</p>
    <ul>
      <li><strong>Describe it (no gestures):</strong> instead of acting, describe the word out loud without saying the word itself or any part of it — the forbidden-word twist.</li>
      <li><strong>Speed round:</strong> a short per-word timer with an auto-skip, so teams blitz through as many words as they can.</li>
      <li><strong>Draw it:</strong> sketch the word instead of acting — no talking, no letters or numbers on the page.</li>
      <li><strong>One sentence only:</strong> you may say a single sentence to get your team there — choose it carefully.</li>
      <li><strong>Streak bonus:</strong> reward momentum by adding bonus time every few correct answers in a row.</li>
      <li><strong>Bet on it:</strong> before the round, a team wagers points on how many words they think they can nail — make the bid and win big, miss it and lose the stake.</li>
    </ul>

    <h2>Tips for a better game</h2>
    <ul>
      <li><strong>Mix easy and hard words</strong> so every turn has a fighting chance — see our sorted <a href="/charades-words">word lists</a>.</li>
      <li><strong>Deal words blind.</strong> The actor should not pick their own word; surprise is where the comedy lives.</li>
      <li><strong>Agree on the signals first</strong> so nobody wastes their minute explaining the rules mid-turn.</li>
      <li><strong>Keep teams even.</strong> Balanced team sizes keep the score meaningful.</li>
      <li><strong>Set a round limit</strong> up front so the game has a clear finish and a clear winner.</li>
    </ul>

    <h2>Skip the prep</h2>
    <p>Writing slips, watching the clock and tracking score by hand is the tedious part. Shout Party handles all of it: it deals words nobody has seen, runs the round timer, tallies the score, and ships the variations above as ready-to-play modes — in 29 languages, fully offline.</p>
`;
const howToLd = {
  '@context': 'https://schema.org',
  '@type': 'HowTo',
  name: 'How to play charades',
  description: 'The rules of charades: set up teams, act out words in silence, guess against a timer, and use the classic hand signals and popular variations.',
  totalTime: 'PT2M',
  step: [
    { '@type': 'HowToStep', name: 'Make two teams', text: 'Split all players into two teams that take turns acting.' },
    { '@type': 'HowToStep', name: 'Draw a word in secret', text: 'The actor gets a word their own team cannot see, picked by the other team or an app.' },
    { '@type': 'HowToStep', name: 'Act it out in silence', text: 'Start a one-minute timer and act the word with no talking, mouthing or pointing.' },
    { '@type': 'HowToStep', name: 'Guess against the clock', text: 'The actor’s team shouts guesses until they get it or time runs out.' },
    { '@type': 'HowToStep', name: 'Score and rotate', text: 'Score a point for each word guessed in time, then pass play and rotate actors.' },
  ],
};
await writeFile(path.join(OUT, 'how-to-play-charades.html'), contentPage({
  slug: 'how-to-play-charades',
  title: 'How to Play Charades — Rules, Signals and Variations | Shout Party',
  description: 'Learn how to play charades: full rules, the classic hand signals, popular variations, and tips for a great game. Plus free word lists to get started.',
  h1: 'How to play charades',
  cta: 'howto',
  jsonLd: howToLd,
  body: howToBody,
}));

// --- Page: Charades words ---------------------------------------------------
// Word samples are drawn from the shipping English deck (1,500 words), so the
// lists match real in-game content across the ten categories and three tiers.
const W = {
  easy: ['Chair', 'Dog', 'Pizza', 'Guitar', 'Ball', 'King', 'Tree', 'Rocket', 'Dress', 'Phone', 'Cake', 'Elephant', 'Movie', 'Mountain', 'Sword', 'Frog', 'Penguin', 'Book'],
  medium: ['Umbrella', 'Rehearsal', 'Substitute', 'Gladiator', 'Estuary', 'Platypus', 'Marinate', 'Itinerary', 'Cashmere', 'Spotlight', 'Chameleon', 'Kimchi', 'Tuxedo', 'Avalanche', 'Javelin', 'Screenplay'],
  hard: ['Chandelier', 'Soliloquy', 'Decathlon', 'Mitochondria', 'Sarcophagus', 'Atoll', 'Velodrome', 'Charcuterie', 'Caravanserai', 'Jacquard', 'Denouement', 'Bioluminescence', 'Cuneiform', 'Umami', 'Vaudeville', 'Mirepoix'],
  animals: ['Dog', 'Cat', 'Elephant', 'Penguin', 'Octopus', 'Meerkat', 'Platypus', 'Chameleon', 'Narwhal', 'Pangolin', 'Armadillo', 'Crocodile'],
  food: ['Pizza', 'Cheese', 'Sushi', 'Cake', 'Burger', 'Marinate', 'Paella', 'Kimchi', 'Charcuterie', 'Umami', 'Tagine', 'Caramelise'],
  entertainment: ['Movie', 'Dance', 'Circus', 'Concert', 'Magic', 'Screenplay', 'Spotlight', 'Soundtrack', 'Pantomime', 'Cinematography', 'Puppet', 'Overture'],
  sports: ['Ball', 'Goal', 'Race', 'Trophy', 'Referee', 'Penalty', 'Offside', 'Javelin', 'Fencing', 'Decathlon', 'Hurdle', 'Archery'],
  everyday: ['Chair', 'Table', 'Phone', 'Key', 'Umbrella', 'Mirror', 'Scissors', 'Hammer', 'Wallet', 'Chandelier', 'Toothbrush', 'Colander'],
  nature: ['Tree', 'River', 'Mountain', 'Rain', 'Volcano', 'Desert', 'Glacier', 'Tundra', 'Avalanche', 'Geyser', 'Estuary', 'Monsoon'],
  funny: ['Pangolin', 'Vaudeville', 'Charcuterie', 'Soliloquy', 'Platypus', 'Kimchi', 'Caravanserai', 'Narwhal', 'Chandelier', 'Meerkat', 'Bellows', 'Tuxedo'],
  kids: ['Dog', 'Cat', 'Cake', 'Ball', 'Tree', 'Elephant', 'Pizza', 'Rocket', 'Frog', 'Guitar', 'Penguin', 'Butterfly'],
};
const wordsBody = `
    <p class="lead">Stuck for ideas? Here is a hand-picked list of charades words, sorted by difficulty and by theme, all pulled straight from the Shout Party decks. Skim a list, pick your favourites, or use them as a warm-up before the real game. New to the game? Start with <a href="/how-to-play-charades">how to play charades</a>.</p>

    <h2>How to use these lists</h2>
    <ul>
      <li><strong>Mix the tiers.</strong> Blend easy and hard words so every player has a fair shot.</li>
      <li><strong>Deal them blind.</strong> Have someone else pick the word so the actor is genuinely surprised.</li>
      <li><strong>No repeats.</strong> Cross off words as you use them to keep each round fresh.</li>
    </ul>

    <h2>Easy charades words</h2>
    <p>Short, concrete and instantly recognisable — perfect for warm-ups, younger players and mixed groups.</p>
    ${chips(W.easy)}

    <h2>Medium charades words</h2>
    <p>A step up: still guessable, but they reward a bit of creativity from the actor.</p>
    ${chips(W.medium)}

    <h2>Hard charades words</h2>
    <p>For experienced players who want a challenge — abstract, technical or delightfully obscure, and often the source of the biggest laughs.</p>
    ${chips(W.hard)}

    <h2>Charades words by category</h2>
    <h3>Animals</h3>
    ${chips(W.animals)}
    <h3>Food &amp; drink</h3>
    ${chips(W.food)}
    <h3>Movies &amp; entertainment</h3>
    ${chips(W.entertainment)}
    <h3>Sports</h3>
    ${chips(W.sports)}
    <h3>Everyday objects</h3>
    ${chips(W.everyday)}
    <h3>Nature</h3>
    ${chips(W.nature)}

    <h2>Funny charades words for adults</h2>
    <p>The trickier words tend to produce the most ridiculous performances. These are crowd-pleasers when the group is up for a challenge.</p>
    ${chips(W.funny)}

    <h2>Charades words for kids</h2>
    <p>Simple, friendly and easy to act — great for family game nights and younger players.</p>
    ${chips(W.kids)}

    <div class="note"><p>These are a small sample. The Shout Party app ships <strong>1,500 words per language</strong> across ten categories and three difficulty tiers, dealt automatically so nobody sees the answers — in 29 languages.</p></div>
`;
const wordsLd = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: 'Charades words and ideas, sorted by difficulty and category',
  description: 'Charades words sorted by difficulty (easy, medium, hard) and by theme — animals, food, movies, sports and more, plus funny words for adults and easy words for kids.',
  author: { '@type': 'Organization', name: 'SEPULKA S.R.L.' },
  publisher: { '@type': 'Organization', name: 'SEPULKA S.R.L.' },
  mainEntityOfPage: 'https://shoutparty.com/charades-words',
};
await writeFile(path.join(OUT, 'charades-words.html'), contentPage({
  slug: 'charades-words',
  title: 'Charades Words and Ideas — Easy, Medium and Hard Lists | Shout Party',
  description: 'Charades words sorted by difficulty and category: easy words for kids, hard words for adults, plus animals, food, movies, sports and more.',
  h1: 'Charades words & ideas',
  cta: 'words',
  jsonLd: wordsLd,
  body: wordsBody,
}));

// --- Localized landing pages (/<code>/) -------------------------------------
// Render the store-listing full description into HTML, deriving structure only
// from the ✦ (section heading) and • (bullet) markers. Bare URLs are linkified.
function renderListingBody(full) {
  const linkify = (t) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="noopener">$1</a>');
  let out = '';
  let inUl = false;
  const closeUl = () => { if (inUl) { out += '    </ul>\n'; inUl = false; } };
  for (const raw of full.split('\n')) {
    const line = raw.trim();
    if (!line) { closeUl(); continue; }
    if (line.startsWith('✦')) {
      closeUl();
      out += `    <h2>${esc(line.replace(/^✦\s*/, ''))}</h2>\n`;
    } else if (line.startsWith('•')) {
      if (!inUl) { out += '    <ul>\n'; inUl = true; }
      out += `      <li>${linkify(line.replace(/^•\s*/, ''))}</li>\n`;
    } else {
      closeUl();
      out += `    <p>${linkify(line)}</p>\n`;
    }
  }
  closeUl();
  return out;
}

function localePage(code) {
  const L = LISTINGS[code];
  const url = localeUrl(code);
  const dir = RTL.has(code) ? ' dir="rtl"' : '';
  const appLdLocale = {
    '@context': 'https://schema.org',
    '@type': 'MobileApplication',
    name: 'Shout Party',
    operatingSystem: 'Android',
    applicationCategory: 'GameApplication',
    applicationSubCategory: 'Party Game',
    url,
    downloadUrl: 'https://play.google.com/store/apps/details?id=com.sepulka.shoutparty',
    description: L.short,
    inLanguage: code,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@type': 'Organization', name: 'SEPULKA S.R.L.' },
  };
  return `<!DOCTYPE html>
<html lang="${code}"${dir}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(L.title)}</title>
<meta name="description" content="${esc(L.short)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
${hreflangSet}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Shout Party">
<meta property="og:title" content="${esc(L.title)}">
<meta property="og:description" content="${esc(L.short)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="https://shoutparty.com/assets/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="${OG_LOCALE[code]}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(L.title)}">
<meta name="twitter:description" content="${esc(L.short)}">
<meta name="twitter:image" content="https://shoutparty.com/assets/og-image.png">
<style>${CONTENT_CSS}</style>
${ldScript(appLdLocale)}
</head>
<body>
<header class="site">
  <div class="wrap">
    <a class="logo" href="/"><span class="shout">SHOUT</span><span class="party">PARTY</span></a>
    ${navCta(`lang_${code}`, CTA_LABEL[code])}
  </div>
</header>
<main>
  <div class="wrap">
    <h1>${esc(L.title)}</h1>
    <p class="lead">${esc(L.short)}</p>
    <p><a class="cta-badge" href="${playUrl(`lang_${code}`)}" target="_blank" rel="noopener"><img src="/assets/google-play-badge.png" alt="Get it on Google Play" width="160" height="62"></a></p>
${renderListingBody(L.full)}
    <div class="cta">
      <a class="cta-badge" href="${playUrl(`lang_${code}`)}" target="_blank" rel="noopener"><img src="/assets/google-play-badge.png" alt="Get it on Google Play" width="160" height="62"></a>
    </div>
  </div>
</main>
<footer class="site">
  <div class="wrap footer-inner">
    <div class="logo"><span class="shout">SHOUT</span><span class="party">PARTY</span></div>
    <div><a href="/">English</a><br>© 2026 SEPULKA S.R.L. · Bucharest, Romania · CUI 50254340 · <a href="mailto:contact@sepulka.cc">contact@sepulka.cc</a> · <a href="/privacy">Privacy</a><br>Google Play and the Google Play logo are trademarks of Google LLC.</div>
  </div>
</footer>
${cfBeacon}
</body>
</html>
`;
}

let localeCount = 0;
for (const code of LOCALES) {
  if (code === 'en') continue; // English is the homepage
  if (!CTA_LABEL[code]) throw new Error(`CTA_LABEL missing for locale ${code}`);
  await mkdir(path.join(OUT, code), { recursive: true });
  await writeFile(path.join(OUT, code, 'index.html'), localePage(code));
  localeCount++;
}
console.log(`Wrote ${localeCount} localized landing pages`);

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
  LOCALES.filter((c) => c !== 'en').map((c) =>
    '  <url>\n' +
    `    <loc>https://shoutparty.com/${c}/</loc>\n` +
    `    <lastmod>${today}</lastmod>\n` +
    '    <changefreq>monthly</changefreq>\n' +
    '    <priority>0.7</priority>\n' +
    '  </url>\n').join('') +
  '  <url>\n' +
  '    <loc>https://shoutparty.com/how-to-play-charades</loc>\n' +
  `    <lastmod>${today}</lastmod>\n` +
  '    <changefreq>monthly</changefreq>\n' +
  '    <priority>0.8</priority>\n' +
  '  </url>\n' +
  '  <url>\n' +
  '    <loc>https://shoutparty.com/charades-words</loc>\n' +
  `    <lastmod>${today}</lastmod>\n` +
  '    <changefreq>monthly</changefreq>\n' +
  '    <priority>0.8</priority>\n' +
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
