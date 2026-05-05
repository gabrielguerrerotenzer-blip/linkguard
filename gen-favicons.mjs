// Genera set completo de favicons e iconos PWA
// Uso: node gen-favicons.mjs
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── SVGs ────────────────────────────────────────────────────────────────────

// Favicon pequeño: solo ".uy" (legible a 16-32px)
const SVG_SMALL = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="#111111"/>
  <text x="16" y="22" text-anchor="middle"
        font-family="'Arial Black', 'Arial Bold', Arial, sans-serif"
        font-weight="900" font-size="15" fill="#F4D03F">.uy</text>
</svg>`);

// Icono completo: "fraude.uy" (usado para 192, 512)
const SVG_FULL = readFileSync(join(__dirname, 'icon.svg'));

// Apple Touch Icon: "fraude.uy" con ~12% de padding interno por lado
// para que el texto entre completo en pantallas iOS
const SVG_APPLE = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#111111"/>
  <text x="256" y="284" text-anchor="middle"
        font-family="'DM Sans', 'Arial Black', Arial, sans-serif"
        font-weight="700" font-size="80" letter-spacing="-1">
    <tspan fill="#7BB8E0">fraude.</tspan><tspan fill="#F4D03F">uy</tspan>
  </text>
</svg>`);

// Maskable: "fraude.uy" con 20% de padding (zona segura Android)
// 512px total → padding 20% = 102px cada lado → contenido en 308x308 centrado
const SVG_MASKABLE = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#111111"/>
  <text x="256" y="280" text-anchor="middle"
        font-family="'DM Sans', 'Arial Black', Arial, sans-serif"
        font-weight="700" font-size="72" letter-spacing="-1">
    <tspan fill="#7BB8E0">fraude.</tspan><tspan fill="#F4D03F">uy</tspan>
  </text>
</svg>`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function gen(svgBuf, size, name) {
  const out = join(__dirname, name);
  await sharp(svgBuf).resize(size, size).png().toFile(out);
  const bytes = readFileSync(out).length;
  console.log(`✓ ${name.padEnd(42)} ${size}x${size}  ${(bytes/1024).toFixed(1)} KB`);
  return out;
}

// ─── Favicon pequeño (16 y 32) ───────────────────────────────────────────────
await gen(SVG_SMALL, 16, 'favicon-16x16.png');
await gen(SVG_SMALL, 32, 'favicon-32x32.png');

// ─── Apple Touch Icons ───────────────────────────────────────────────────────
await gen(SVG_APPLE, 180, 'apple-touch-icon.png');
await gen(SVG_APPLE, 180, 'apple-touch-icon-precomposed.png');
await gen(SVG_APPLE, 120, 'apple-touch-icon-120x120.png');
await gen(SVG_APPLE, 120, 'apple-touch-icon-120x120-precomposed.png');
await gen(SVG_APPLE, 152, 'apple-touch-icon-152x152.png');
await gen(SVG_APPLE, 167, 'apple-touch-icon-167x167.png');

// ─── PWA ─────────────────────────────────────────────────────────────────────
await gen(SVG_FULL, 192, 'icon-192.png');
await gen(SVG_FULL, 512, 'icon-512.png');
await gen(SVG_MASKABLE, 512, 'icon-maskable-512.png');

// ─── favicon.ico (multi-size con versión simplificada ".uy") ─────────────────
const ico16 = await sharp(SVG_SMALL).resize(16, 16).png().toBuffer();
const ico32 = await sharp(SVG_SMALL).resize(32, 32).png().toBuffer();
const ico48 = await sharp(SVG_SMALL).resize(48, 48).png().toBuffer();

const images = [
  { buf: ico16, w: 16, h: 16 },
  { buf: ico32, w: 32, h: 32 },
  { buf: ico48, w: 48, h: 48 },
];

const HEADER_SIZE    = 6;
const DIR_ENTRY_SIZE = 16;
const numImages = images.length;
let dataOffset = HEADER_SIZE + DIR_ENTRY_SIZE * numImages;

const header = Buffer.alloc(HEADER_SIZE);
header.writeUInt16LE(0,         0);
header.writeUInt16LE(1,         2);
header.writeUInt16LE(numImages, 4);

const dirs = [], chunks = [];
for (const img of images) {
  const dir = Buffer.alloc(DIR_ENTRY_SIZE);
  dir.writeUInt8(img.w === 256 ? 0 : img.w, 0);
  dir.writeUInt8(img.h === 256 ? 0 : img.h, 1);
  dir.writeUInt8(0,  2);
  dir.writeUInt8(0,  3);
  dir.writeUInt16LE(1,  4);
  dir.writeUInt16LE(32, 6);
  dir.writeUInt32LE(img.buf.length, 8);
  dir.writeUInt32LE(dataOffset,     12);
  dirs.push(dir);
  chunks.push(img.buf);
  dataOffset += img.buf.length;
}

const icoPath = join(__dirname, 'favicon.ico');
writeFileSync(icoPath, Buffer.concat([header, ...dirs, ...chunks]));
const icoBytes = readFileSync(icoPath).length;
console.log(`✓ ${'favicon.ico'.padEnd(42)} 16+32+48  ${(icoBytes/1024).toFixed(1)} KB`);

console.log('\nDone! Set completo de íconos generado.');
