'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

async function buildSingleFileExe(root, appFolder, outputExePath) {
  const workDir = path.dirname(appFolder);
  const stubExe = path.join(workDir, 'stub.exe');
  const payloadZip = path.join(workDir, 'payload.zip');
  const launcherCs = path.join(root, 'scripts', 'portable-launcher.cs');
  const iconPath = path.join(root, 'app.ico');
  const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

  await execFileAsync(cscPath, [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/platform:x64',
    `/win32icon:${iconPath}`,
    `/out:${stubExe}`,
    '/r:System.IO.Compression.dll',
    '/r:System.IO.Compression.FileSystem.dll',
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    launcherCs
  ]);

  await fs.rm(payloadZip, { force: true });
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${appFolder.replace(/'/g, "''")}', '${payloadZip.replace(/'/g, "''")}', [System.IO.Compression.CompressionLevel]::Fastest, $false)`
  ]);

  const asarPath = path.join(appFolder, 'resources', 'app.asar');
  const asarBytes = await fs.readFile(asarPath);
  const hashDigest = crypto.createHash('sha256').update(asarBytes).digest();
  const buildHash = hashDigest.readBigUInt64LE(0);

  const stubStat = await fs.stat(stubExe);
  const zipStat = await fs.stat(payloadZip);
  const zipOffset = BigInt(stubStat.size);
  const zipLength = BigInt(zipStat.size);

  const trailer = Buffer.alloc(32);
  trailer.writeBigInt64LE(zipOffset, 0);
  trailer.writeBigInt64LE(zipLength, 8);
  trailer.writeBigUInt64LE(buildHash, 16);
  trailer.write('MGREEN01', 24, 8, 'ascii');

  const tempOut = `${outputExePath}.tmp-${process.pid}`;
  await fs.copyFile(stubExe, tempOut);

  const outHandle = await fs.open(tempOut, 'a');
  try {
    const zipHandle = await fs.open(payloadZip, 'r');
    try {
      const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
      let pos = 0;
      while (true) {
        const { bytesRead } = await zipHandle.read(chunk, 0, chunk.length, pos);
        if (bytesRead <= 0) break;
        await outHandle.write(chunk, 0, bytesRead);
        pos += bytesRead;
      }
    } finally {
      await zipHandle.close();
    }
    await outHandle.write(trailer, 0, trailer.length);
  } finally {
    await outHandle.close();
  }

  await fs.rm(stubExe, { force: true });
  await fs.rm(payloadZip, { force: true });
  await fs.rename(tempOut, outputExePath);
}

async function build() {
  const { packager } = await import('@electron/packager');
  const root = path.resolve(__dirname, '..');
  // A distinct output per build avoids overwriting an app the user may be running.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(root, 'dist', stamp);
  const zipDirectory = path.join(root, '.test-data');
  const localZip = await fs.stat(path.join(zipDirectory, `electron-v${require('../package.json').devDependencies.electron}-win32-x64.zip`)).catch(() => null);
  const apps = await packager({
    dir: root, out: output, name: 'Music Green', executableName: 'Music Green',
    platform: 'win32', arch: 'x64', electronVersion: require('../package.json').devDependencies.electron,
    ...(localZip ? { electronZipDir: zipDirectory } : {}),
    asar: true, prune: true,
    icon: path.join(root, 'app.ico'),
    ignore: [
      /^\/dist($|\/)/,
      /^\/tests($|\/)/,
      /^\/test-media($|\/)/,
      /^\/scripts($|\/)/,
      /^\/\.test-data($|\/)/,
      /^\/\.git($|\/)/,
      /^\/package-lock\.json$/,
      /^\/Music Green\.exe$/,
      /^\/Music Green\.cmd$/
    ],
    appCopyright: 'Music Green — personal offline player'
  });
  const executable = path.join(apps[0], 'Music Green.exe');
  const portableExe = path.join(root, 'Music Green.exe');
  await buildSingleFileExe(root, apps[0], portableExe);
  await fs.rm(path.join(root, 'Music Green.cmd'), { force: true });
  console.log('Built folder executable:', executable);
  console.log('Built standalone single-file executable:', portableExe);
  await fs.writeFile(path.join(root, 'dist', 'latest.json'), JSON.stringify({ executable, portableExecutable: portableExe, folder: apps[0] }, null, 2));
}

if (require.main === module) {
  build().catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { build, buildSingleFileExe };
