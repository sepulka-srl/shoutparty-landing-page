// Extract a Claude Design bundle.html into a static site:
//   - assets/<id>.<ext> for each binary asset
//   - index.html with template content + UUID placeholders rewritten to assets/ paths
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const BUNDLE = path.join(ROOT, 'shout-party-landing.bundle.html');
const OUT = path.join(ROOT, 'docs');
const ASSETS = path.join(OUT, 'assets');

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

const uuidToPath = {};
let assetCount = 0;
for (const [uuid, entry] of Object.entries(manifest)) {
  let bytes = Buffer.from(entry.data, 'base64');
  if (entry.compressed) bytes = gunzipSync(bytes);
  const ext = mimeExt[entry.mime] || 'bin';
  const filename = `${uuid}.${ext}`;
  await writeFile(path.join(ASSETS, filename), bytes);
  uuidToPath[uuid] = `assets/${filename}`;
  assetCount++;
}
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

// Build __resources object so any code reading window.__resources still works.
const resourceMap = {};
for (const e of extResources) {
  if (uuidToPath[e.uuid]) resourceMap[e.id] = uuidToPath[e.uuid];
}
const resourceScript = `<script>window.__resources = ${JSON.stringify(resourceMap).split('</script>').join('<\\/script>')};</script>`;
template = template.replace(/<head[^>]*>/i, (m) => m + resourceScript);

// Wire Play Store CTAs. The generated bundle uses href="#" / href="#download"
// for the three Google Play buttons; point them all at the live listing.
const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.sepulka.shoutparty';
template = template
  .replace(
    '<a class="nav-cta" href="#download" aria-label="Get on Google Play">',
    `<a class="nav-cta" href="${PLAY_URL}" target="_blank" rel="noopener" aria-label="Get on Google Play">`
  )
  .replace(
    /<a class="gp-badge" href="#(?:download)?" aria-label="Get it on Google Play">/g,
    `<a class="gp-badge" href="${PLAY_URL}" target="_blank" rel="noopener" aria-label="Get it on Google Play">`
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
  // commercial operators identifying themselves to consumers.
  .replace(
    '© 2026 Sepulka</div>',
    '© 2026 SEPULKA S.R.L. · Bucharest, Romania · CUI 50254340 · <a href="mailto:contact@sepulka.cc">contact@sepulka.cc</a></div>'
  );

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

// GitHub Pages: custom domain + skip Jekyll processing.
await writeFile(path.join(OUT, 'CNAME'), 'shoutparty.com\n');
await writeFile(path.join(OUT, '.nojekyll'), '');

console.log('Wrote docs/index.html, CNAME, .nojekyll');
