#!/usr/bin/env node
// Fetch the standalone Node.js runtime that runs the inference worker in the
// packaged app (see spawnWorker() in src/main/main.js for why it can't run
// inside Electron), verify it against the official SHASUMS256.txt, and put
// just the binary into build/node/ - electron-builder ships that directory as
// resources/node (extraResources).
//
// Usage: node scripts/fetch-node.js [--platform=darwin|win32|linux] [--arch=arm64|x64]
// Defaults to the host platform/arch, which is what every CI build job needs
// (each job builds its own OS). Runs automatically before `npm run build`.

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

// Pinned for reproducible builds. Any current LTS works: the worker's native
// modules (onnxruntime-node, node-llama-cpp, sharp) are all N-API.
const NODE_VERSION = 'v24.21.0'

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const platform = arg('platform') || process.platform
const arch = arg('arch') || process.arch

const DIST = { darwin: 'darwin', win32: 'win', linux: 'linux' }[platform]
if (!DIST) throw new Error(`Unsupported platform: ${platform}`)
const ext = platform === 'win32' ? 'zip' : 'tar.gz'
const base = `node-${NODE_VERSION}-${DIST}-${arch}`
const file = `${base}.${ext}`
const url = `https://nodejs.org/dist/${NODE_VERSION}/${file}`

const outDir = path.join(__dirname, '..', 'build', 'node')
const binName = platform === 'win32' ? 'node.exe' : 'node'
const outBin = path.join(outDir, binName)
const stamp = path.join(outDir, '.version')

async function download(u) {
  const res = await fetch(u)
  if (!res.ok) throw new Error(`GET ${u}: ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

async function main() {
  const want = `${file}\n`
  if (fs.existsSync(outBin) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) {
    console.log(`fetch-node: ${file} already present`)
    return
  }
  console.log(`fetch-node: downloading ${url}`)
  const [archive, sums] = await Promise.all([download(url), download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`)])
  const expected = sums.toString('utf8').split('\n').find((l) => l.endsWith(`  ${file}`))?.split(/\s+/)[0]
  const actual = crypto.createHash('sha256').update(archive).digest('hex')
  if (!expected || expected !== actual) throw new Error(`fetch-node: checksum mismatch for ${file} (expected ${expected}, got ${actual})`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-node-'))
  try {
    const archivePath = path.join(tmp, file)
    fs.writeFileSync(archivePath, archive)
    // bsdtar (macOS, Windows 10+) and GNU tar (Linux) both handle these; on
    // Windows tar.exe also extracts .zip.
    const inner = platform === 'win32' ? `${base}/${binName}` : `${base}/bin/${binName}`
    execFileSync('tar', ['-xf', archivePath, '-C', tmp, inner], { stdio: 'inherit' })
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })
    fs.copyFileSync(path.join(tmp, inner), outBin)
    fs.chmodSync(outBin, 0o755)
    fs.writeFileSync(stamp, want)
    console.log(`fetch-node: ${outBin} (${NODE_VERSION}, ${platform}-${arch}, sha256 ok)`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
