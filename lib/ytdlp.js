'use strict';

// ─── yt-dlp: the extractor behind the built-in JSTube player ───
// Downloads the official yt-dlp release for this platform into the cache directory the first time it
// is needed and refreshes it weekly, so a plain `npm start` plays videos without any manual setup and
// keeps up with YouTube's changes (a stale copy quietly loses videos). YTDLP_PATH pins a binary of your
// own; a copy on PATH is only used when the download is impossible. YouTube requires a JavaScript
// runtime to solve its player challenges; the Node running this server is handed to yt-dlp for that.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('./config');
const { log } = require('./log');

const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;   // a managed binary older than this is refreshed in the background
const RETRY_DOWNLOAD_AFTER_MS = 60 * 60 * 1000;     // after a failed run, at most one forced re-download per hour
const DOWNLOAD_TIMEOUT_MS = 180000;
const MAX_BINARY_BYTES = 200 * 1024 * 1024;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const EXE = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

const state = {
    binary: null,          // { path, managed }
    downloading: null,     // in-flight download promise
    lastDownloadAt: 0,
    lastError: null,
};

function releaseAsset() {
    const { platform, arch } = process;
    if (platform === 'darwin') return 'yt-dlp_macos';            // universal: Intel and Apple Silicon
    if (platform === 'win32') return arch === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
    if (platform === 'linux') {
        if (arch === 'x64') return 'yt-dlp_linux';
        if (arch === 'arm64') return 'yt-dlp_linux_aarch64';
    }
    return null;   // 32-bit ARM Linux only ships a zip; set YTDLP_PATH there
}

const managedPath = () => path.join(config.tube.cacheDir, 'bin', EXE);
const ytdlpCacheDir = () => path.join(config.tube.cacheDir, 'yt-dlp');

async function isExecutable(file) {
    try {
        await fsp.access(file, fs.constants.X_OK);
        return (await fsp.stat(file)).isFile();
    } catch { return false; }
}

async function findOnPath() {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        const candidate = path.join(dir, EXE);
        if (await isExecutable(candidate)) return candidate;
    }
    return null;
}

async function mtimeOf(file) {
    try { return (await fsp.stat(file)).mtimeMs; } catch { return 0; }
}

/** True when this machine can have a yt-dlp at all (configured, found, or downloadable). */
function canProvide() {
    return Boolean(state.binary || config.tube.ytdlpPath || releaseAsset());
}

// Downloads the current release for this platform into the cache directory. Single-flight.
function download(reason) {
    if (state.downloading) return state.downloading;
    state.downloading = (async () => {
        const asset = releaseAsset();
        if (!asset) throw new Error(`no yt-dlp release exists for ${process.platform}/${process.arch}; set YTDLP_PATH`);
        const target = managedPath();
        await fsp.mkdir(path.dirname(target), { recursive: true });
        log('JSTUBE', `Downloading yt-dlp (${asset}): ${reason}`);
        const response = await fetch(RELEASE_BASE + asset, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!response.ok || !response.body) throw new Error(`yt-dlp download failed: HTTP ${response.status}`);
        const declared = parseInt(response.headers.get('content-length') || '0', 10);
        if (declared > MAX_BINARY_BYTES) throw new Error('yt-dlp download is unexpectedly large');

        const temp = target + '.download';
        let size = 0;
        const counter = new Transform({
            transform(chunk, _encoding, callback) {
                size += chunk.length;
                if (size > MAX_BINARY_BYTES) return callback(new Error('yt-dlp download is unexpectedly large'));
                callback(null, chunk);
            },
        });
        try {
            // pipeline() tears everything down on any error (network, disk full, unwritable directory).
            await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(temp, { mode: 0o755 }));
            if (size < 1024 * 1024) throw new Error('yt-dlp download was incomplete');
        } catch (err) {
            await fsp.rm(temp, { force: true }).catch(() => {});
            throw err;
        }
        await fsp.chmod(temp, 0o755).catch(() => {});
        // Windows cannot replace a running executable in place, but it can rename it aside.
        const old = target + '.old';
        await fsp.rm(old, { force: true }).catch(() => {});
        await fsp.rename(target, old).catch(() => {});
        await fsp.rename(temp, target);
        fsp.rm(old, { force: true }).catch(() => {});
        state.lastDownloadAt = Date.now();
        state.lastError = null;
        state.binary = { path: target, managed: true };
        log('JSTUBE', `yt-dlp ready at ${target} (${Math.round(size / 1048576)} MB)`);
        return target;
    })().catch((err) => { state.lastError = err.message; throw err; })
        .finally(() => { state.downloading = null; });
    return state.downloading;
}

/** Path to a usable yt-dlp, downloading one on first use. */
async function ensure() {
    if (state.binary && await isExecutable(state.binary.path)) return state.binary.path;
    state.binary = null;
    if (config.tube.ytdlpPath) {
        if (!await isExecutable(config.tube.ytdlpPath)) throw new Error(`YTDLP_PATH (${config.tube.ytdlpPath}) is not an executable file`);
        state.binary = { path: config.tube.ytdlpPath, managed: false };
        return state.binary.path;
    }
    const managed = managedPath();
    if (await isExecutable(managed)) {
        state.binary = { path: managed, managed: true };
        // YouTube changes break old extractors, so the managed binary is refreshed weekly in the background.
        if (Date.now() - await mtimeOf(managed) > REFRESH_AFTER_MS && !state.downloading) {
            download('weekly refresh').catch((err) => log('JSTUBE', 'yt-dlp refresh failed: ' + err.message));
        }
        return managed;
    }
    try { return await download('first use'); }
    catch (err) {
        const onPath = await findOnPath();
        if (!onPath) throw err;
        log('JSTUBE', `yt-dlp download failed (${err.message}); using the copy on PATH at ${onPath}`);
        state.binary = { path: onPath, managed: false };
        return onPath;
    }
}

// yt-dlp spawns a JavaScript runtime of its own for YouTube's challenges. The whole tree runs in its own
// process group, so killing a stuck run takes the runtime with it and nothing in that tree can signal us.
const OWN_GROUP = process.platform !== 'win32';

function killTree(child) {
    if (OWN_GROUP) { try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* group already gone */ } }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

function run(binary, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: OWN_GROUP, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        } catch (err) { return reject(err); }
        const stdout = [];
        let outBytes = 0;
        let stderr = '';
        let done = false;
        const finish = (err, result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (err) reject(err); else resolve(result);
        };
        const timer = setTimeout(() => { finish(new Error('yt-dlp took too long')); killTree(child); }, timeoutMs);
        child.on('error', (err) => finish(err));
        child.stdout.on('data', (chunk) => {
            outBytes += chunk.length;
            if (outBytes > MAX_STDOUT_BYTES) { finish(new Error('yt-dlp output was too large')); killTree(child); return; }
            stdout.push(chunk);
        });
        child.stderr.on('data', (chunk) => { if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8'); });
        child.on('close', (code) => finish(null, { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr }));
    });
}

// "ERROR: [youtube] abc: Sign in to confirm ..." → "Sign in to confirm ..."
function cleanError(stderr) {
    const lines = stderr.split('\n').map(s => s.trim()).filter(Boolean);
    const error = [...lines].reverse().find(line => line.startsWith('ERROR:')) || lines[lines.length - 1] || '';
    return error.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[A-Za-z0-9_-]{11}:\s*/, '').slice(0, 200);
}

/** Runs `yt-dlp -J` for a video and returns the parsed metadata (formats, manifests, flags). */
async function info(videoId) {
    const args = [
        '-J', '--skip-download', '--no-playlist', '--no-warnings', '--no-progress',
        '--js-runtimes', 'node:' + process.execPath,
        '--cache-dir', ytdlpCacheDir(),
        '--', 'https://www.youtube.com/watch?v=' + videoId,
    ];
    let binary = await ensure();
    let result = await run(binary, args, config.tube.resolveTimeoutMs);
    // Only a failure that looks like a broken extractor justifies fetching a new release; a private or removed
    // video, a sign-in wall or a network error would fail identically with the newest yt-dlp.
    const looksLikeExtractorBreak = result.code !== 0 && /nsig|n challenge|signature|player response|unable to extract|jsinterp|failed to parse|jsc|challenge solver/i.test(result.stderr);
    if (looksLikeExtractorBreak && state.binary && state.binary.managed && Date.now() - state.lastDownloadAt > RETRY_DOWNLOAD_AFTER_MS) {
        log('JSTUBE', 'yt-dlp failed (' + cleanError(result.stderr) + '); fetching the latest release and retrying once');
        try {
            binary = await download('extractor failure');
            result = await run(binary, args, config.tube.resolveTimeoutMs);
        } catch (err) { log('JSTUBE', 'yt-dlp re-download failed: ' + err.message); }
    }
    if (result.code !== 0) throw new Error(cleanError(result.stderr) || `yt-dlp exited with code ${result.code}`);
    try { return JSON.parse(result.stdout); }
    catch { throw new Error('yt-dlp returned unreadable data'); }
}

function status() {
    return {
        ready: Boolean(state.binary),
        managed: state.binary ? state.binary.managed : false,
        downloading: Boolean(state.downloading),
        failed: Boolean(state.lastError && !state.binary),
    };
}

module.exports = { ensure, info, status, canProvide, releaseAsset };
