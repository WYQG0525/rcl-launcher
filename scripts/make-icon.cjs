'use strict';
// 生成 exe 图标：PowerShell + GDI+ 画 256x256 PNG，再打包成 ICO（PNG 压缩的 icon 条目，现代 Windows 支持）
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const build = path.join(ROOT, 'build');
fs.mkdirSync(build, { recursive: true });
const png = path.join(build, 'icon.png');
const ico = path.join(build, 'icon.ico');

const ps = `
Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap $size,$size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$c1 = [System.Drawing.Color]::FromArgb(255,61,120,255)
$c2 = [System.Drawing.Color]::FromArgb(255,130,80,255)
$lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Rectangle(0,0,$size,$size)), $c1, $c2, 45
$g.FillRectangle($lg, 0, 0, $size, $size)
$w = [System.Drawing.Brushes]::White
$g.FillRectangle($w, 34, 168, 188, 14)
$g.FillRectangle($w, 34, 194, 132, 14)
try {
  $font = New-Object System.Drawing.Font("Segoe UI", 74, ([System.Drawing.FontStyle]::Bold -bor [System.Drawing.FontStyle]::Italic))
} catch {
  $font = New-Object System.Drawing.Font("Arial", 74, [System.Drawing.FontStyle]::Bold)
}
$pt = New-Object System.Drawing.PointF 22, 34
$g.DrawString("RCL", $font, $w, $pt)
$g.Dispose()
$bmp.Save("${png.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`;
execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });

const pngBuf = fs.readFileSync(png);
// ICONDIR(6) + ICONDIRENTRY(16) + PNG
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); entry.writeUInt8(0, 1);            // 256x256 用 0 表示
entry.writeUInt16LE(1, 2); entry.writeUInt16LE(32, 4);     // 平面数 / 位深
entry.writeUInt32LE(pngBuf.length, 8);
entry.writeUInt32LE(22, 12);                               // 数据偏移
fs.writeFileSync(ico, Buffer.concat([header, entry, pngBuf]));
console.log('图标已生成：', ico, (fs.statSync(ico).size / 1024).toFixed(1) + 'KB');
