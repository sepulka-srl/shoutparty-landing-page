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
  );

await writeFile(path.join(OUT, 'index.html'), template);

// GitHub Pages: custom domain + skip Jekyll processing.
await writeFile(path.join(OUT, 'CNAME'), 'shoutparty.com\n');
await writeFile(path.join(OUT, '.nojekyll'), '');

console.log('Wrote docs/index.html, CNAME, .nojekyll');
