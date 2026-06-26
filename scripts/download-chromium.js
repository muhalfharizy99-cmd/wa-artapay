/**
 * Post-install script: downloads a pinned Chromium revision into .chromium/
 * so the app is self-contained and does not depend on a system-installed Chrome.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROMIUM_DIR = path.resolve(__dirname, '..', '.chromium');
const MARKER_FILE = path.join(CHROMIUM_DIR, '.revision');

// Pin the Chromium revision that matches the puppeteer version bundled with whatsapp-web.js
// This revision is for Chrome 146 (matches puppeteer@24.x / win64-146.0.7680.153)
const CHROMIUM_REVISION = '146.0.7680.153';

function isChromiumReady() {
    if (!fs.existsSync(MARKER_FILE)) return false;
    try {
        const saved = fs.readFileSync(MARKER_FILE, 'utf-8').trim();
        return saved === CHROMIUM_REVISION;
    } catch {
        return false;
    }
}

function findChromiumBinary() {
    // Check if binary already exists in .chromium/
    const isWin = process.platform === 'win32';
    const platformPrefix = isWin ? 'win64-' : 'linux-';
    const subDir = isWin ? 'chrome-win64' : 'chrome-linux64';
    const chromeBin = isWin ? 'chrome.exe' : 'chrome';

    try {
        if (!fs.existsSync(CHROMIUM_DIR)) return false;
        const entries = fs.readdirSync(CHROMIUM_DIR).filter(d => d.startsWith(platformPrefix));
        for (const v of entries) {
            const p = path.join(CHROMIUM_DIR, v, subDir, chromeBin);
            if (fs.existsSync(p)) return true;
        }
    } catch {}
    return false;
}

if (isChromiumReady() && findChromiumBinary()) {
    console.log(`[chromium] Already downloaded (revision ${CHROMIUM_REVISION})`);
    process.exit(0);
}

console.log(`[chromium] Downloading Chromium ${CHROMIUM_REVISION} into .chromium/ ...`);

try {
    // Use puppeteer's built-in browser installer
    // npx puppeteer browsers install chrome@REVISION --path .chromium
    execSync(
        `npx puppeteer browsers install chrome@${CHROMIUM_REVISION} --path "${CHROMIUM_DIR}"`,
        {
            cwd: path.resolve(__dirname, '..'),
            stdio: 'inherit',
            timeout: 300000, // 5 min timeout for download
        }
    );

    // Write marker so we skip re-downloading next time
    fs.mkdirSync(CHROMIUM_DIR, { recursive: true });
    fs.writeFileSync(MARKER_FILE, CHROMIUM_REVISION, 'utf-8');
    console.log(`[chromium] Download complete (revision ${CHROMIUM_REVISION})`);
} catch (err) {
    console.error(`[chromium] Failed to download Chromium: ${err?.message || err}`);
    console.error('[chromium] The app will fall back to system Chrome / puppeteer cache.');
    // Don't fail the entire npm install
    process.exit(0);
}
