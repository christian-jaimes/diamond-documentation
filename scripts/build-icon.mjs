// Renders media/logo.svg into the Marketplace icon (media/icon.png): the logo on a dark rounded tile,
// so the light-blue artwork stays visible on light backgrounds too.
import sharp from 'sharp';
import { readFileSync } from 'fs';

const size = 256;
const logo = readFileSync('media/logo.svg', 'utf8').replace(/viewBox="[^"]*"/, 'viewBox="40 35 1176 1176"');
const art = await sharp(Buffer.from(logo)).resize(196, 196).png().toBuffer();
const tile = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14263a"/><stop offset="1" stop-color="#0a131d"/></linearGradient></defs>
  <rect width="${size}" height="${size}" rx="48" fill="url(#g)"/></svg>`);
await sharp(tile).composite([{ input: art, gravity: 'center' }]).png().toFile('media/icon.png');
console.log('wrote media/icon.png');
