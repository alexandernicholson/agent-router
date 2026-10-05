import test from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_COLORS, CACHE_SURFACES, themeFamily } from '../lib/cache-colors.js';

const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
const linear = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = hex => { const [r, g, b] = linear(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
function difference(a, b, kind) {
  const seen = hex => { const c = linear(hex); return kind ? MACHADO[kind].map(row => Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))) : c; };
  const [p, q] = [oklab(seen(a)), oklab(seen(b))];
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
const pairs = colors => colors.flatMap((a, i) => colors.slice(i + 1).map(b => [a, b]));

for (const [family, colors] of Object.entries(CACHE_COLORS)) {
  const grades = [colors.good, colors.fair, colors.poor];
  const modes = [colors.warm, colors.compact];

  test(`${family}: grade colours are readable text on every ${family} background`, () => {
    for (const color of grades) for (const surface of CACHE_SURFACES[family]) {
      assert.ok(contrast(color, surface) >= 4.5, `${color} on ${surface}: ${contrast(color, surface).toFixed(2)}`);
    }
  });

  test(`${family}: mode markers meet non-text contrast on every ${family} background`, () => {
    for (const color of modes) for (const surface of CACHE_SURFACES[family]) {
      assert.ok(contrast(color, surface) >= 3, `${color} on ${surface}: ${contrast(color, surface).toFixed(2)}`);
    }
  });

  test(`${family}: grades and modes stay apart with and without colour vision deficiency`, () => {
    for (const set of [grades, modes]) for (const [a, b] of pairs(set)) {
      assert.ok(difference(a, b) >= 15, `${a}/${b} normal ${difference(a, b).toFixed(1)}`);
      for (const kind of ['protan', 'deutan', 'tritan']) {
        assert.ok(difference(a, b, kind) >= 8, `${a}/${b} ${kind} ${difference(a, b, kind).toFixed(1)}`);
      }
    }
    for (const mode of modes) for (const grade of grades) {
      assert.ok(difference(mode, grade) >= 15, `${mode}/${grade} normal ${difference(mode, grade).toFixed(1)}`);
    }
  });
}

test('the theme picks the palette for its background', () => {
  for (const theme of ['dark', 'dark-daltonized', 'dark-ansi']) assert.equal(themeFamily(theme), 'dark');
  for (const theme of ['light', 'light-daltonized', 'light-ansi']) assert.equal(themeFamily(theme), 'light');
  assert.equal(themeFamily('auto'), 'dark');
  assert.equal(themeFamily('auto', '0;15'), 'light');
  assert.equal(themeFamily('auto', '15;0'), 'dark');
  assert.equal(themeFamily(undefined, '0;7'), 'light');
  assert.equal(themeFamily(42), 'dark');
});
