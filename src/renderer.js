const $ = id => document.getElementById(id);
let allResults = [];
let activePage = 'discover';
let activeDownloads = new Map();
let library = [];
let libraryFolder = '';
let toastTimer;

function toast(message, error = false) {
  const el = $('toast'); el.textContent = message; el.classList.remove('hidden', 'error');
  if (error) el.classList.add('error');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 4800);
}
function humanSize(bytes) {
  if (!bytes) return 'Unknown size';
  const units = ['B','KB','MB','GB','TB']; let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}
function humanSpeed(bytes) { return bytes ? `${humanSize(bytes)}/s` : '—'; }
function safeText(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function quality(title) { return (String(title).match(/(?:2160|1080|720|480)p/i) || ['—'])[0].toUpperCase(); }
function renderResults() {
  const term = $('quality-filter').value;
  const sort = $('sort-filter').value;
  let rows = allResults.filter(r => !term || quality(r.title) === term.toUpperCase());
  rows.sort((a,b) => sort === 'size' ? b.size-a.size : sort === 'title' ? a.title.localeCompare(b.title) : b.timestamp-a.timestamp);
  $('results-summary').textContent = `${rows.length} release${rows.length === 1 ? '' : 's'}${$('search-input').value.trim() ? ` for “${$('search-input').value.trim()}”` : ''}`;
  const host = $('results'); host.classList.toggle('empty-state', !rows.length);
  if (!rows.length) {
    host.innerHTML = `<div class="empty-icon">⌕</div><h2>No matching releases</h2><p>Try a different title or clear the quality filter.</p>`;
    return;
  }
  host.innerHTML = rows.map((r,i) => {
    const q = quality(r.title);
    const date = r.timestamp ? new Date(r.timestamp*1000).toLocaleDateString() : 'Catalog result';
    return `<article class="release">
      <div class="release-art">▶</div>
      <div><div class="release-title">${safeText(r.title)}</div><div class="release-sub">${safeText(date)} · ${r.files || '—'} file(s)</div><div class="release-tags"><span class="tag">${safeText(q)}</span><span class="tag">Torrent</span>${r.magnet ? '<span class="tag">Magnet ready</span>' : '<span class="tag">Torrent URL</span>'}</div></div>
      <div><div class="metric-label">Quality</div><div class="metric">${safeText(q)}</div></div>
      <div><div class="metric-label">Size</div><div class="metric">${humanSize(r.size)}</div></div>
      <div><div class="metric-label">Added</div><div class="metric">${safeText(date)}</div></div>
      <button class="btn primary add-release" data-index="${allResults.indexOf(r)}">⇩ Download</button>
    </article>`;
  }).join('');
  host.querySelectorAll('.add-release').forEach(btn => btn.addEventListener('click', async () => {
    const r = allResults[Number(btn.dataset.index)];
    const validMagnet = typeof r.magnet === 'string' && /^magnet:\?/i.test(r.magnet) && /(?:\?|&)xt=urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})(?:&|$)/i.test(r.magnet);
    const uri = validMagnet ? r.magnet : (r.torrentUrl || r.magnet);
    if (!uri) return toast('This result does not provide a torrent link.', true);
    try {
      btn.disabled = true; btn.textContent = 'Adding…';
      await window.openReel.addTorrent(uri);
      toast('Torrent added to the download queue.');
      await refreshDownloads(); navigate('downloads');
    } catch (e) { toast(e.message || 'Could not add torrent.', true); btn.disabled = false; btn.textContent = '⇩ Download'; }
  }));
}
async function search(query) {
  const q = (query ?? $('search-input').value).trim();
  if (!q) { toast('Enter a title to search.'); return; }
  $('search-input').value = q;
  $('connection-status').textContent = 'Searching…';
  $('notice').classList.add('hidden');
  $('results-summary').textContent = 'Searching catalog…';
  $('results').innerHTML = `<div class="empty-icon">⌕</div><h2>Searching in the background…</h2><p>Contacting the catalog feed. This can take a few seconds.</p>`;
  $('results').classList.add('empty-state');
  try {
    const response = await window.openReel.search(q, 1);
    allResults = response.results || [];
    if (response.error) {
      $('notice').textContent = response.message; $('notice').classList.remove('hidden'); $('notice').classList.add('error');
      $('connection-status').textContent = 'Catalog unavailable';
    } else {
      $('connection-status').textContent = 'Search complete';
      if (response.message) { $('notice').textContent = response.message; $('notice').classList.remove('hidden'); $('notice').classList.remove('error'); }
    }
    renderResults();
  } catch (e) {
    allResults = []; $('connection-status').textContent = 'Search failed';
    $('notice').textContent = e.message; $('notice').classList.remove('hidden'); $('notice').classList.add('error'); renderResults();
  }
}
function navigate(page) {
  activePage = page;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('hidden', el.id !== `page-${page}`));
  const info = {
    discover: ['Discover', ''],
    library: ['Library', ''],
    downloads: ['Downloads', ''],
    settings: ['Settings', '']
  }[page];
  $('page-title').textContent = info[0]; $('page-subtitle').textContent = info[1];
  if (page === 'downloads') refreshDownloads();
  if (page === 'library') renderLibrary();
}
function renderDownloads(items) {
  const host = $('downloads-list');
  $('download-count').textContent = items.filter(x => !x.done).length;
  if (!items.length) {
    host.innerHTML = `<div class="empty-card"><div class="empty-icon">⇩</div><h2>Your queue is clear</h2><p>Search the catalog or paste a magnet link above to add a download.</p></div>`; return;
  }
  host.innerHTML = items.map(d => `<article class="download-card">
    <div class="download-head"><div><b>${safeText(d.name)}</b><div class="download-meta">${d.done ? 'Completed' : d.paused ? 'Paused' : `${d.peers} peers · ${humanSpeed(d.speed)}`} · ${humanSize(d.downloaded)} / ${humanSize(d.length)}</div></div><span class="progress-num">${d.progress.toFixed(1)}%</span></div>
    <div class="progress-row"><div class="progress"><span style="width:${Math.max(0,Math.min(100,d.progress))}%"></span></div><span class="progress-num">${d.done ? 'Done' : d.paused ? 'Paused' : humanSpeed(d.speed)}</span></div>
    <div class="download-actions">${d.done ? `<button class="btn primary play-file" data-id="${safeText(d.id)}">▶ Play first file</button>` : d.paused ? `<button class="btn secondary resume" data-id="${safeText(d.id)}">Resume</button>` : `<button class="btn secondary pause" data-id="${safeText(d.id)}">Pause</button>`}<button class="btn secondary show-folder">Folder</button><button class="btn secondary remove" data-id="${safeText(d.id)}">Remove</button><button class="btn secondary remove-delete" data-id="${safeText(d.id)}">Delete files</button></div>
    ${d.done && d.files?.length ? `<div class="download-meta">Files: ${d.files.map((f,i)=>`<button class="suggestion play-index" data-id="${safeText(d.id)}" data-index="${i}">${safeText(f.name)}</button>`).join(' ')}</div>` : ''}
  </article>`).join('');
  async function runDownloadAction(button, action, successMessage) {
    if (button.dataset.busy === '1') return;
    button.dataset.busy = '1';
    button.disabled = true;
    const oldLabel = button.textContent;
    button.textContent = '…';
    try {
      const result = await action(button.dataset.id);
      if (result === false) throw new Error('The download is no longer active.');
      await refreshDownloads();
      toast(successMessage);
    } catch (error) {
      toast(error?.message || 'Download action failed.', true);
    } finally {
      button.disabled = false;
      button.dataset.busy = '0';
      button.textContent = oldLabel;
    }
  }
  host.querySelectorAll('.pause').forEach(b => b.onclick = () => runDownloadAction(b, id => window.openReel.pause(id), 'Paused.'));
  host.querySelectorAll('.resume').forEach(b => b.onclick = () => runDownloadAction(b, id => window.openReel.resume(id), 'Resumed.'));
  host.querySelectorAll('.remove').forEach(b => b.onclick = () => {
    if (!confirm('Remove this download from AniBrary? Downloaded files will be kept.')) return;
    runDownloadAction(b, id => window.openReel.remove(id, false), 'Removed from queue. Files kept.');
  });
  host.querySelectorAll('.remove-delete').forEach(b => b.onclick = () => {
    if (!confirm('Permanently delete this torrent and its downloaded data? This cannot be undone.')) return;
    runDownloadAction(b, id => window.openReel.remove(id, true), 'Download and files deleted.');
  });
  host.querySelectorAll('.show-folder').forEach(b => b.onclick = async () => {
    try { await window.openReel.openFolder(); } catch (error) { toast(error?.message || 'Could not open folder.', true); }
  });
  host.querySelectorAll('.play-file,.play-index').forEach(b => b.onclick = async () => {
    try { const item = await window.openReel.openDownloaded(b.dataset.id, Number(b.dataset.index || 0)); toast(`Opening ${item.name} in Windows.`); }
    catch (e) { toast(e.message, true); }
  });
}
async function refreshDownloads() {
  try { const items = await window.openReel.listDownloads(); activeDownloads = new Map(items.map(x=>[x.id,x])); renderDownloads(items); $('download-count').textContent = items.filter(x=>!x.done).length; }
  catch {}
}
function cleanMediaTitle(raw, isFolder = false) {
  let name = String(raw || '').replace(/\.[^.]+$/, '').replace(/-\s*[A-Z0-9]{3,}$/i, '');
  name = name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Extract season/episode markers so they can lead the displayed title.
  const seasonMatch = name.match(/\bS(\d{1,2})\b/i);
  const episodeMatch = name.match(/\b(?:EP?|E)\s?(\d{1,3})\b/i);
  const season = seasonMatch ? `S${String(seasonMatch[1]).padStart(2, '0')}` : '';
  const episode = episodeMatch && !isFolder ? `EP${String(episodeMatch[1]).padStart(2, '0')}` : '';
  name = name.replace(/\bS\d{1,2}\b/ig, ' ')
             .replace(/\b(?:EP?|E)\s?\d{1,3}\b/ig, ' ');

  // Remove common release metadata and year; keep only a useful language tag.
  name = name.replace(/\b(?:19|20)\d{2}\b/g, ' ');
  const technical = /\b(?:2160p|1080p|1080i|720p|576p|480p|4k|8k|blu ?ray|bdrip|brrip|webrip|web ?dl|hdtv|dvdrip|remux|x264|x265|h\.?264|h\.?265|hevc|av1|xvid|10bit|8bit|opus|aac|flac|truehd|dts|hdr10?\+?|dolby vision|proper|repack|reencode|sample|german|english|japanese|multi|dual audio|dualaudio|ml)\b/i;
  const match = name.match(technical);
  if (match && typeof match.index === 'number') {
    const prefix = name.slice(0, match.index).trim();
    const tag = match[0].toLowerCase();
    name = prefix + (tag === 'german' || tag === 'english' || tag === 'japanese' ? ` ${tag[0].toUpperCase()}${tag.slice(1)}` : '');
  }
  name = name.replace(/\s+/g, ' ').trim();
  const prefix = [season, episode].filter(Boolean).join(' ');
  return [prefix, name].filter(Boolean).join(' · ') || String(raw || '').replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim();
}

async function renderLibrary() {
  const host = $('library-list');
  try {
    const data = await window.openReel.listLibrary(libraryFolder);
    library = data.files || [];
    $('library-breadcrumb').textContent = data.relative ? `AniBrary  /  ${data.relative.split(/[\\\\/]/).map(part => cleanMediaTitle(part, true)).join('  /  ')}` : 'AniBrary';
    $('library-count').textContent = `${data.folders.length} folders · ${data.files.length} videos`;
    $('library-back').classList.toggle('hidden', !data.relative);
    host.innerHTML = [
      ...data.folders.map(folder => `<button class="library-card folder-card" data-folder="${safeText(folder.name)}"><div class="folder-art"><span class="folder-icon">▰</span><span class="folder-open">Open season</span></div><div class="library-card-title">${safeText(cleanMediaTitle(folder.name, true))}</div><div class="library-card-meta"></div></button>`),
      ...data.files.map(file => `<article class="library-card video-card"><button class="video-art" data-file="${safeText(file.path)}" aria-label="Play ${safeText(file.name)}"><div class="thumb-placeholder">▶</div><img class="library-thumb" data-thumb="${safeText(file.path)}" alt="" loading="lazy"><span class="play-disc">▶</span></button><div class="library-card-title" title="${safeText(file.name)}">${safeText(cleanMediaTitle(file.name))}</div></article>`)
    ].join('');
    $('library-empty').classList.toggle('hidden', data.folders.length + data.files.length > 0);
    host.classList.toggle('hidden', data.folders.length + data.files.length === 0);
    host.querySelectorAll('.folder-card').forEach(card => card.onclick = () => { libraryFolder = libraryFolder ? `${libraryFolder}/${card.dataset.folder}` : card.dataset.folder; renderLibrary(); });
    const thumbs = [...host.querySelectorAll('.library-thumb')];
    // Generate only thumbnails that are visible; this prevents a large library
    // from launching dozens of ffmpeg processes at once.
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          loadThumb(entry.target);
        });
      }, { rootMargin: '180px' });
      thumbs.forEach(img => observer.observe(img));
    } else {
      thumbs.slice(0, 4).forEach(loadThumb);
    }
    async function loadThumb(img) {
      try { img.src = await window.openReel.getThumbnail(img.dataset.thumb); img.classList.add('loaded'); }
      catch { img.parentElement.classList.add('no-thumb'); }
    }
    host.querySelectorAll('.video-art,.library-play').forEach(btn => btn.onclick = async () => {
      try {
        const item = await window.openReel.openLibraryFile(btn.dataset.file);
        toast(`Opening ${item.name} in Windows.`);
      } catch (e) { toast(e.message || 'Could not open video.', true); }
    });
  } catch (e) {
    host.innerHTML = '';
    $('library-empty').classList.remove('hidden');
    $('library-empty').querySelector('h2').textContent = 'Library unavailable';
    $('library-empty').querySelector('p').textContent = e.message || 'Could not read the OpenReel folder.';
  }
}
$('search-form').addEventListener('submit', e=>{e.preventDefault();search();});
$('clear-search').onclick=()=>{$('search-input').value='';$('search-input').focus();};
$('quality-filter').onchange=renderResults; $('sort-filter').onchange=renderResults;
document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>navigate(b.dataset.page));
document.querySelectorAll('.suggestion').forEach(b=>{ if (b.classList.contains('suggestion') && b.closest('#results')) b.onclick=()=>search(b.textContent); });
$('magnet-form').addEventListener('submit', async e=>{
  e.preventDefault(); const input=$('magnet-input').value.trim(); if(!input)return;
  try { await window.openReel.addTorrent(input); $('magnet-input').value=''; toast('Torrent added.'); await refreshDownloads(); }
  catch(err){toast(err.message || 'Could not add torrent.',true);}
});
$('pick-video').onclick=async()=>{try{const v=await window.openReel.pickVideo();if(!v)return;toast(`Opening ${v.name} in Windows.`);}catch(e){toast(e.message||'Could not open video.',true);}};
$('open-folder').onclick=()=>window.openReel.openFolder(); $('settings-folder').onclick=()=>window.openReel.openFolder();
$('library-open-folder').onclick=()=>window.openReel.openFolder();
$('library-refresh').onclick=()=>renderLibrary();
$('library-back').onclick=()=>{libraryFolder=libraryFolder.split(/[\\\\/]/).slice(0,-1).join('/');renderLibrary();};
window.openReel.onTorrentUpdate(update=>{
  activeDownloads.set(update.id,update);
  if (activePage==='downloads') renderDownloads(Array.from(activeDownloads.values()));
  $('download-count').textContent=Array.from(activeDownloads.values()).filter(x=>!x.done).length;
});
window.openReel.getDirectory().then(dir=>$('download-location').textContent=dir).catch(()=>{});
setTimeout(() => refreshDownloads(), 250);



window.addEventListener('error', event => {
  try { toast(`UI error: ${event.message || 'unknown error'}`, true); } catch {}
});
window.addEventListener('unhandledrejection', event => {
  try { toast(`Action failed: ${event.reason?.message || String(event.reason || 'unknown error')}`, true); } catch {}
});
