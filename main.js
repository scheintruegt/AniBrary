const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const ffmpegPath = require('ffmpeg-static');
const crypto = require('node:crypto');
let WebTorrent;
let parseTorrent;

let win;
let client;
const downloads = new Map();
const downloadDir = path.join(app.getPath('videos'), 'OpenReel');
try {
  const cacheDir = path.join(app.getPath('userData'), 'Cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  app.setPath('cache', cacheDir);
} catch (error) {
  console.warn('Could not configure the Electron cache directory:', error.message);
}
fs.mkdirSync(downloadDir, { recursive: true });

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 980, minHeight: 680,
    backgroundColor: '#101316',
    title: 'AniBrary',
    icon: path.join(__dirname, 'assets', 'anibrary.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}
app.whenReady().then(() => {
  // Show the UI immediately. Loading the torrent engine can take time on first run,
  // so never block BrowserWindow creation on it.
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  setTimeout(() => {
    try {
      WebTorrent = require('webtorrent');
      parseTorrent = require('parse-torrent');
      client = new WebTorrent();
      client.on('error', err => {
        if (win && !win.isDestroyed()) win.webContents.send('app:error', { message: `Torrent engine: ${err.message}` });
      });
      if (win && !win.isDestroyed()) win.webContents.send('app:engine-ready');
    } catch (err) {
      if (win && !win.isDestroyed()) win.webContents.send('app:error', { message: `Download engine failed to start: ${err.message}` });
    }
  }, 0);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { client?.destroy(); } catch {} });
setInterval(() => {
  if (!win || win.isDestroyed()) return;
  for (const entry of downloads.values()) {
    try { win.webContents.send('torrent:update', snapshotTorrent(entry)); } catch {}
  }
}, 1000).unref();


ipcMain.handle('catalog:search', async (_event, query, page = 1) => {
  const q = String(query || '').trim();
  if (!q) return { results: [], message: 'Enter a title to search.' };
  const pageNumber = Math.min(100, Math.max(1, Number(page) || 1));

  // AnimeTosho's original feed host was shut down in October 2026.
  // Anime Tosho New uses the successor feed host. Keep the old host as a
  // fallback only in case the successor has a temporary outage or DNS issue.
  const hosts = [
    'https://feed.animetosho.net/json',
    'https://feed.animetosho.org/json'
  ];
  let lastError = 'No catalog endpoint could be reached.';
  for (const endpoint of hosts) {
    const url = new URL(endpoint);
    url.searchParams.set('qx', '1');
    url.searchParams.set('q', q);
    url.searchParams.set('page', String(pageNumber));
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'OpenReel/0.3' },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        lastError = `${new URL(endpoint).host} returned HTTP ${response.status}`;
        continue;
      }
      const data = await response.json();
      if (!Array.isArray(data)) {
        lastError = `${new URL(endpoint).host} returned an unexpected response`;
        continue;
      }
      const results = data.map((item, i) => ({
        id: String(item.tosho_id ?? item.nyaa_id ?? item.anidex_id ?? item.id ?? `${i}-${item.timestamp ?? ''}`),
        title: String(item.title || 'Untitled release'),
        size: Number(item.total_size ?? item.size) || 0,
        files: Number(item.num_files) || 0,
        seeders: Number(item.seeders) || 0,
        leechers: Number(item.leechers) || 0,
        timestamp: Number(item.timestamp) || 0,
        magnet: typeof item.magnet_uri === 'string' ? item.magnet_uri : '',
        torrentUrl: typeof item.torrent_url === 'string' ? item.torrent_url : '',
        sourceUrl: typeof item.link === 'string' ? item.link :
          (item.tosho_id ? `https://animetosho.org/view/${item.tosho_id}` : 'https://animetosho.net/')
      })).filter(x => x.title);
      return {
        results,
        source: new URL(endpoint).host,
        message: results.length ? '' : 'No releases found. Try a shorter title or different spelling.'
      };
    } catch (error) {
      lastError = `${new URL(endpoint).host}: ${error.message}`;
    }
  }
  return {
    results: [],
    error: true,
    message: `Could not reach Anime Tosho New or the legacy feed (${lastError}). You can still add a magnet link manually.`
  };
});

function isValidMagnet(uri) {
  if (!/^magnet:\?/i.test(uri)) return false;
  const params = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
  const xts = params.getAll('xt');
  return xts.some(xt =>
    /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(xt) ||
    /^urn:btmh:1220[a-f0-9]{64}$/i.test(xt)
  );
}

async function resolveTorrentInput(input) {
  const uri = String(input || '').trim();
  if (!uri) throw new Error('No torrent link was provided.');

  // Validate first, but pass WebTorrent the input type it natively understands.
  // parse-torrent's parsed object is not a safe substitute for a magnet URI in
  // all WebTorrent 2.x paths (some paths expect raw hash-buffer fields).
  if (/^magnet:\?/i.test(uri)) {
    let parsed;
    try { parsed = await parseTorrent(uri); }
    catch (error) { throw new Error(`Invalid magnet link: ${error.message}`); }
    if (!parsed || typeof parsed.infoHash !== 'string' || !/^[a-f0-9]{40}$/i.test(parsed.infoHash)) {
      throw new Error('This magnet link has no valid BitTorrent info hash.');
    }
    return { kind: 'magnet', value: uri };
  }

  let parsedUrl;
  try { parsedUrl = new URL(uri); }
  catch { throw new Error('Paste a valid magnet link or direct .torrent URL.'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || !/\.torrent$/i.test(parsedUrl.pathname)) {
    throw new Error('Provide a magnet link or a direct URL ending in .torrent.');
  }
  const response = await fetch(parsedUrl, {
    headers: { 'User-Agent': 'OpenReel/0.5', 'Accept': 'application/x-bittorrent, application/octet-stream, */*' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Torrent URL returned HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 20 || bytes.length > 20 * 1024 * 1024) {
    throw new Error('The URL did not return a valid-sized .torrent file (max 20 MB).');
  }
  let parsed;
  try { parsed = await parseTorrent(bytes); }
  catch (error) {
    throw new Error(`The URL did not contain a valid torrent file (it may have returned an HTML page instead): ${error.message}`);
  }
  if (!parsed || typeof parsed.infoHash !== 'string' || !/^[a-f0-9]{40}$/i.test(parsed.infoHash)) {
    throw new Error('This URL did not contain a valid BitTorrent info hash.');
  }
  return { kind: 'torrent-file', value: Buffer.from(bytes) };
}


function snapshotTorrent(entry) {
  const t = entry.torrent;
  return {
    id: entry.id, name: entry.name || t.name || 'Torrent download',
    progress: Math.round((t.progress || 0) * 1000) / 10,
    speed: entry.paused ? 0 : (t.downloadSpeed || 0),
    downloaded: t.downloaded || 0, length: t.length || 0,
    peers: entry.paused ? 0 : (t.numPeers || 0), paused: Boolean(entry.paused),
    done: Boolean(t.done),
    files: (t.files || []).map(f => ({ name: f.name, path: f.path, length: f.length }))
  };
}
ipcMain.handle('torrent:add', async (_event, input) => {
  if (!client) throw new Error('Download engine is still starting. Please try again in a moment.');
  let torrentInput;
  try { torrentInput = await resolveTorrentInput(input); }
  catch (error) { throw new Error(error?.message || 'Could not validate this torrent input.'); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = err => {
      if (settled) return;
      settled = true;
      reject(new Error(err?.message || String(err || 'Torrent could not be added.')));
    };
    try {
      const torrent = client.add(torrentInput.value, { path: downloadDir }, t => {
        if (settled) return;
        settled = true;
        const id = t.infoHash;
        const entry = { id, name: t.name || 'Torrent download', torrent: t, paused: false };
        downloads.set(id, entry);
        const send = () => {
          if (!win || win.isDestroyed()) return;
          win.webContents.send('torrent:update', snapshotTorrent(entry));
        };
        t.on('download', send);
        t.on('done', send);
        t.on('wire', send);
        t.on('error', finishReject);
        send();
        resolve({ id, name: entry.name });
      });
      torrent.on('error', finishReject);
    } catch (error) { finishReject(error); }
  });
});

ipcMain.handle('torrent:list', () => Array.from(downloads.values()).map(snapshotTorrent));
ipcMain.handle('torrent:pause', async (_e, id) => {
  if (!client) throw new Error('Download engine is not ready.');
  const key = String(id);
  const d = downloads.get(key);
  if (!d) throw new Error('Download not found in the active queue.');
  if (d.torrent.done) return true;
  // WebTorrent v1's Torrent.pause() is not a reliable network pause for all
  // torrent states. Destroy active wires to stop transfers, but keep the torrent
  // and its storage in the client so it can resume without losing data.
  d.paused = true;
  for (const wire of [...(d.torrent.wires || [])]) {
    try { wire.destroy(); } catch {}
  }
  if (win && !win.isDestroyed()) win.webContents.send('torrent:update', snapshotTorrent(d));
  return true;
});
ipcMain.handle('torrent:resume', async (_e, id) => {
  if (!client) throw new Error('Download engine is not ready.');
  const d = downloads.get(String(id));
  if (!d) throw new Error('Download not found in the active queue.');
  if (d.torrent.done) return true;
  d.paused = false;
  // Reannounce to trackers/DHT so the client discovers peers again.
  try { d.torrent.discovery?.announce?.(); } catch {}
  try { d.torrent.discovery?.update?.(); } catch {}
  if (win && !win.isDestroyed()) win.webContents.send('torrent:update', snapshotTorrent(d));
  return true;
});
ipcMain.handle('torrent:remove', async (_e, id, deleteFiles = false) => {
  if (!client) throw new Error('Download engine is not ready.');
  const d = downloads.get(String(id));
  if (!d) throw new Error('This download is no longer in the queue.');
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve();
    };
    try {
      const result = client.remove(d.id, { destroyStore: Boolean(deleteFiles) }, error => finish(error));
      // Some WebTorrent builds return the removed torrent instead of invoking
      // the optional callback consistently. Observe the client's torrent list.
      if (result && typeof result.then === 'function') result.then(() => finish(), finish);
      setTimeout(() => {
        if (client.get(d.id)) return;
        finish();
      }, 1500);
    } catch (error) { finish(error); }
  });
  downloads.delete(String(id));
  return true;
});
const videoExtensions = new Set(['.mkv', '.mp4', '.webm', '.mov', '.avi', '.m4v', '.mpeg', '.mpg', '.wmv', '.ts']);
function libraryEntry(filePath, type) {
  const stat = fs.statSync(filePath);
  return {
    name: path.basename(filePath),
    path: filePath,
    type,
    size: stat.isFile() ? stat.size : 0,
    modified: stat.mtimeMs,
    extension: path.extname(filePath).slice(1).toUpperCase()
  };
}
ipcMain.handle('library:list', async (_event, folder = '') => {
  const root = path.resolve(downloadDir);
  const current = path.resolve(root, String(folder || ''));
  if (current !== root && !current.startsWith(root + path.sep)) throw new Error('Invalid library folder.');
  const stat = await fs.promises.stat(current).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error('Library folder not found.');
  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  const folders = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(current, entry.name);
    try {
      if (entry.isDirectory()) folders.push(libraryEntry(full, 'folder'));
      else if (entry.isFile() && videoExtensions.has(path.extname(entry.name).toLowerCase())) files.push(libraryEntry(full, 'video'));
    } catch {}
  }
  folders.sort((a,b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  files.sort((a,b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { root, current, relative: path.relative(root, current), folders, files };
});

const mediaCacheDir = path.join(app.getPath('userData'), 'media-cache');
const thumbDir = path.join(mediaCacheDir, 'thumbnails');
const playbackDir = path.join(mediaCacheDir, 'playback');
fs.mkdirSync(thumbDir, { recursive: true });
fs.mkdirSync(playbackDir, { recursive: true });
const browserPlayable = new Set(['.mp4', '.webm', '.mov', '.m4v']);
function cacheKey(full, stat) {
  return crypto.createHash('sha1').update(`${full}|${stat.size}|${stat.mtimeMs}`).digest('hex');
}
async function createThumbnail(full) {
  const stat = await fs.promises.stat(full);
  const key = cacheKey(full, stat);
  const thumb = path.join(thumbDir, `${key}.jpg`);
  if (!fs.existsSync(thumb)) {
    try {
      await runFile(ffmpegPath, ['-hide_banner','-loglevel','error','-ss','00:00:08','-i',full,'-frames:v','1','-vf','scale=480:-2:force_original_aspect_ratio=decrease','-q:v','5','-y',thumb], { windowsHide: true, timeout: 60000 });
    } catch {
      try { await fs.promises.unlink(thumb); } catch {}
      await runFile(ffmpegPath, ['-hide_banner','-loglevel','error','-i',full,'-frames:v','1','-vf','scale=480:-2:force_original_aspect_ratio=decrease','-q:v','5','-y',thumb], { windowsHide: true, timeout: 60000 });
    }
  }
  const data = await fs.promises.readFile(thumb);
  return `data:image/jpeg;base64,${data.toString('base64')}`;
}
async function preparePlayback(full) {
  const resolved = path.resolve(String(full || ''));
  const stat = await fs.promises.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile() || !videoExtensions.has(path.extname(resolved).toLowerCase())) {
    throw new Error('Video file not found.');
  }
  const error = await shell.openPath(resolved);
  if (error) {
    throw new Error(`Windows could not open this video: ${error}. Set a default video player in Windows Settings.`);
  }
  return { name: path.basename(resolved), external: true };
}
ipcMain.handle('library:thumbnail', async (_event, filePath) => {
  const full = path.resolve(String(filePath || ''));
  if (!full.startsWith(path.resolve(downloadDir) + path.sep)) throw new Error('Invalid library path.');
  if (!videoExtensions.has(path.extname(full).toLowerCase())) throw new Error('Not a video file.');
  return createThumbnail(full);
});
ipcMain.handle('library:open-file', async (_event, filePath) => {
  const full = path.resolve(String(filePath || ''));
  if (!full.startsWith(path.resolve(downloadDir) + path.sep)) throw new Error('This file is outside the Open Reel library.');
  return preparePlayback(full);
});
ipcMain.handle('library:pick', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open a video file', properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mkv','mp4','webm','mov','avi','m4v','mpeg','mpg','wmv','ts'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return preparePlayback(result.filePaths[0]);
});
ipcMain.handle('library:open-download', async (_e, id, fileIndex = 0) => {
  const d = downloads.get(String(id)); if (!d) throw new Error('Download not found.');
  const f = d.torrent.files[Number(fileIndex)];
  if (!f) throw new Error('File not found.');
  if (!d.torrent.done) throw new Error('This file is not finished downloading yet.');
  return preparePlayback(f.path);
});
ipcMain.handle('downloads:open-folder', () => shell.openPath(downloadDir));
ipcMain.handle('downloads:directory', () => downloadDir);
ipcMain.handle('external:open', (_e, url) => {
  const parsed = new URL(String(url));
  if (['https:', 'http:'].includes(parsed.protocol)) return shell.openExternal(parsed.toString());
});
