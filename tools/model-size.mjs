/**
 * How big is the sukkah, really?
 *
 *     node tools/model-size.mjs                  measure it
 *     node tools/model-size.mjs --height 2.75    make it that tall, in metres
 *
 * WHY THIS EXISTS
 * A glTF file has no units setting: one unit is one metre, always. Nothing
 * warns you when a model is exported at the wrong scale, because on a web
 * page it never matters - <model-viewer> frames whatever it is given, so a
 * model half a kilometre across looks exactly like a model two metres across.
 *
 * In AR it matters completely. The phone puts the model into the real room at
 * its stated size. The first export of this sukkah was 528 x 352 x 418
 * METRES, so tapping the button put a structure the size of a district around
 * the person holding the phone: the camera opened, the tracking worked, and
 * there was nothing to see, because every surface was either hundreds of
 * metres away or behind them.
 *
 * So this measures first and says the number out loud. Re-run it after any
 * re-export, before publishing.
 *
 * WHAT --height DOES
 * Writes one transform onto the file's root node - a scale, a turn and a lift
 * - and touches nothing else. The mesh data is not rewritten, so nothing can
 * be lost in a round trip.
 *
 *   scale        so the whole model stands the given height
 *   rotation     a quarter turn, which used to be the page's `orientation`
 *                attribute. That attribute only ever applied on the web page:
 *                Android's Scene Viewer loads this file directly and never
 *                sees it, so the turn belongs in the file.
 *   translation  origin to the centre of the footprint, at ground level,
 *                which is where `ar-placement="floor"` expects it
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'models', 'Sukkah.glb');

/* ---- reading a .glb ------------------------------------------------------
   A container: a 12-byte header, then length-prefixed chunks. The first is
   the scene as JSON; the second is the mesh data as bytes. Only the JSON is
   ever rewritten here. */
function readGlb(file) {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('Not a .glb file.');
  const chunks = [];
  let at = 12;
  while (at < buf.length) {
    const len = buf.readUInt32LE(at);
    const kind = buf.toString('ascii', at + 4, at + 8).trim();
    chunks.push({ kind, data: buf.subarray(at + 8, at + 8 + len) });
    at += 8 + len;
  }
  const json = chunks.find(c => c.kind === 'JSON');
  return { gltf: JSON.parse(json.data.toString('utf8')), chunks };
}

function writeGlb(file, { gltf, chunks }) {
  const out = chunks.map(c => {
    /* JSON pads with spaces, binary pads with zeros; both to four bytes. */
    const data = c.kind === 'JSON' ? Buffer.from(JSON.stringify(gltf), 'utf8') : c.data;
    const pad = (4 - (data.length % 4)) % 4;
    const body = pad ? Buffer.concat([data, Buffer.alloc(pad, c.kind === 'JSON' ? 0x20 : 0)]) : data;
    const head = Buffer.alloc(8);
    head.writeUInt32LE(body.length, 0);
    head.write(c.kind.padEnd(4, '\0'), 4, 'ascii');
    return Buffer.concat([head, body]);
  });
  const total = 12 + out.reduce((n, b) => n + b.length, 0);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  writeFileSync(file, Buffer.concat([header, ...out]));
  return total;
}

/* ---- where the corners land once every parent transform is applied ------ */
function matrixOf(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

const times = (a, b) => {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
  return o;
};

const put = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

function bounds(gltf) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const parts = [];
  const walk = (i, parent) => {
    const node = gltf.nodes[i];
    const here = times(matrixOf(node), parent);
    if (node.mesh != null) {
      const mlo = [Infinity, Infinity, Infinity];
      const mhi = [-Infinity, -Infinity, -Infinity];
      for (const prim of gltf.meshes[node.mesh].primitives) {
        const box = gltf.accessors[prim.attributes.POSITION];
        for (const x of [box.min[0], box.max[0]]) {
          for (const y of [box.min[1], box.max[1]]) {
            for (const z of [box.min[2], box.max[2]]) {
              const w = put(here, [x, y, z]);
              for (let k = 0; k < 3; k++) {
                if (w[k] < lo[k]) lo[k] = w[k];
                if (w[k] > hi[k]) hi[k] = w[k];
                if (w[k] < mlo[k]) mlo[k] = w[k];
                if (w[k] > mhi[k]) mhi[k] = w[k];
              }
            }
          }
        }
      }
      parts.push({ name: gltf.meshes[node.mesh].name ?? `mesh ${node.mesh}`, lo: mlo, hi: mhi });
    }
    for (const c of node.children ?? []) walk(c, here);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const i of gltf.scenes[gltf.scene ?? 0].nodes) walk(i, I);
  return { lo, hi, parts };
}

/* ---- say it ------------------------------------------------------------- */
const metres = n => `${n.toFixed(2)} m`;
const glb = readGlb(FILE);
const before = bounds(glb.gltf);
const size = before.hi.map((v, i) => v - before.lo[i]);

console.log('');
console.log('  models/Sukkah.glb, at the size the file declares:');
console.log('');
console.log(`    wide  ${metres(size[0])}     deep  ${metres(size[2])}     tall  ${metres(size[1])}`);
console.log(`    the bottom sits at y = ${before.lo[1].toFixed(2)}, ${
  Math.abs(before.lo[1]) < 0.005 ? 'which is on the floor' : 'which is not the floor'}`);
for (const p of before.parts) {
  console.log(`      ${p.name.padEnd(7)} ${metres(p.hi[1] - p.lo[1]).padStart(8)} tall`);
}

const askedAt = process.argv.indexOf('--height');
if (askedAt < 0) {
  console.log('');
  console.log('  A sukkah a person can walk into is about 2.75 m to the top of the schach.');
  console.log('  To set it:  node tools/model-size.mjs --height 2.75');
  console.log('');
  process.exit(0);
}

const wanted = Number(process.argv[askedAt + 1]);
if (!(wanted > 0)) throw new Error('--height needs a number of metres.');

const scene = glb.gltf.scenes[glb.gltf.scene ?? 0];
if (scene.nodes.length !== 1) throw new Error('Expected a single root node; not touching this.');
const root = glb.gltf.nodes[scene.nodes[0]];
if (root.mesh != null || root.matrix) throw new Error('The root node is not a plain group; not touching this.');

const factor = wanted / size[1];
const turn = -Math.PI / 2;          // the quarter turn the page used to apply
root.scale = [factor, factor, factor];
root.rotation = [0, Math.sin(turn / 2), 0, Math.cos(turn / 2)];
root.translation = [0, 0, 0];

/* Measure again with the scale and the turn in place, because the turn moves
   which way is wide and which way is deep - then lift and centre from that. */
const turned = bounds(glb.gltf);
root.translation = [
  -(turned.lo[0] + turned.hi[0]) / 2,
  -turned.lo[1],
  -(turned.lo[2] + turned.hi[2]) / 2,
];

const after = bounds(glb.gltf);
const now = after.hi.map((v, i) => v - after.lo[i]);
const total = writeGlb(FILE, glb);

console.log('');
console.log('  written. it is now:');
console.log('');
console.log(`    wide  ${metres(now[0])}     deep  ${metres(now[2])}     tall  ${metres(now[1])}`);
console.log(`    standing on the floor, centred on its own footprint`);
for (const p of after.parts) {
  console.log(`      ${p.name.padEnd(7)} ${metres(p.hi[1] - p.lo[1]).padStart(8)} tall`);
}
console.log(`    ${total} bytes`);
console.log('');
