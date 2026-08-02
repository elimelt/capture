// Generates the PWA icons (solid slate square with a lighter database-cylinder
// glyph) as PNGs, no dependencies. Keep in sync with public/icons/icon.svg.
// Run: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1)
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelFn(x, y)
      const o = row + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Background #0f172a (slate-900), glyph #38bdf8 (sky-400): a database cylinder
// (top ellipse + body split into three bands by curved separators). Geometry
// mirrors public/icons/icon.svg on the same 16-unit grid.
const BG = [15, 23, 42]
const FG = [56, 189, 248]

function makeIcon(size) {
  const u = size / 16
  const cx = 8 // cylinder centre x
  const rx = 3.7 // cylinder half-width
  const ry = 1.2 // ellipse half-height (perspective squash)
  const topY = 4.7 // centre of the top ellipse
  const botY = 11.3 // centre of the bottom ellipse
  const seps = [6.8, 9.05] // band separator baselines
  const gap = 0.55 // separator thickness
  return png(size, (px, py) => {
    const x = (px + 0.5) / u
    const y = (py + 0.5) / u
    const dx = (x - cx) / rx
    if (Math.abs(dx) > 1) return BG
    // Vertical distance from a band baseline to the ellipse arc at this x.
    const edge = ry * Math.sqrt(1 - dx * dx)
    // Silhouette: upper half of the top ellipse, straight sides, lower half
    // of the bottom ellipse.
    if (y < topY - edge || y > botY + edge) return BG
    // Carve the curved separators between bands.
    for (const s of seps) if (y > s + edge && y < s + edge + gap) return BG
    return FG
  })
}

mkdirSync('public/icons', { recursive: true })
for (const size of [192, 512]) {
  writeFileSync(`public/icons/icon-${size}.png`, makeIcon(size))
  console.log(`wrote public/icons/icon-${size}.png`)
}
