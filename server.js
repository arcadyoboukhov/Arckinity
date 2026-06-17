const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const config = require('./config');

function resolveFfmpegBinary() {
  const candidates = [];

  if (process.env.FFMPEG_PATH) {
    candidates.push(process.env.FFMPEG_PATH);
  }

  try {
    const bundledFfmpeg = require('ffmpeg-static');
    if (bundledFfmpeg) {
      candidates.push(bundledFfmpeg);
      // In packaged Electron apps, native binaries are typically unpacked here.
      if (bundledFfmpeg.includes('app.asar')) {
        candidates.push(bundledFfmpeg.replace('app.asar', 'app.asar.unpacked'));
      }
    }
  } catch (e) {
    // ffmpeg-static not available; fallback to system ffmpeg below.
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fsSync.existsSync(candidate)) {
        return candidate;
      }
    } catch (e) { }
  }

  return 'ffmpeg';
}

const ffmpegBin = resolveFfmpegBinary();
let ffmpegDisabled = false;
let ffmpegErrorLogged = false;

/**
 * =============================================================================
 * ARKINITY - SERVER
 * =============================================================================
 * 
 * This is the main Express.js server for Arkinity.
 * 
 * Key Responsibilities:
 * 1. Serves static frontend files (HTML, CSS, JS)
 * 2. Exposes video files via /videos/ endpoint
 * 3. Manages user behavior tracking (watch time, likes)
 * 4. Generates personalized video recommendations
 * 5. Maintains persistent state (recent videos, user behavior)
 * 
 * All paths are configured via config.js for cross-platform compatibility.
 */

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Load configuration - handles cross-platform path setup
const { isValid, errors } = config.validate();
if (!isValid) {
  console.error('Configuration Error:');
  errors.forEach(err => console.error(err));
  console.error('\nPlease configure VIDEO_SOURCE_DIR in config.js or set the VIDEO_SOURCE_DIR environment variable.');
  process.exit(1);
}

const videosRoot = config.videoRoot;

// Serve the front-end static files from project root
app.use(express.static(path.join(__dirname)));

// Expose videos under /videos/<category>/<file>
// This allows the frontend to request video files dynamically
app.use('/videos', express.static(videosRoot, { extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] }));

async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch (e) { }
}

// Fire-and-forget thumbnail generator using ffmpeg. Logs errors but doesn't block.
// Thumbnails are cached as WebP images for faster loading
async function generateThumbnailIfMissing(category, filename) {
  try {
    if (ffmpegDisabled) return;

    const base = filename.replace(/\.[^/.]+$/, '');
    const outDir = path.join(videosRoot, category);
    const outPath = path.join(outDir, base + '.webp');
    try { await fs.access(outPath); return; } catch (e) { /* missing */ }

    await ensureDir(outDir);
    const videoPath = path.join(videosRoot, category, filename);

    const args = ['-ss', '0.5', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=640:-1', '-y', outPath];
    const ff = spawn(ffmpegBin, args, { stdio: 'ignore' });
    ff.on('error', (err) => {
      if (!ffmpegErrorLogged) {
        console.warn('ffmpeg spawn error:', err.message, '| binary:', ffmpegBin);
        ffmpegErrorLogged = true;
      }
      if (err && err.code === 'ENOENT') {
        ffmpegDisabled = true;
      }
    });
    ff.on('exit', (code) => { if (code !== 0) console.warn('ffmpeg exited with code', code, 'for', videoPath); });
  } catch (err) { console.warn('Thumbnail generation failed', category, filename, err && err.message); }
}

// Modify this function to generate a thumbnail for the "next" video before it's used in the display
async function generateNextThumbnailIfNeeded(posts) {
  try {
    for (const post of posts) {
      const filePath = post.videoUrl.replace('/videos/', '');
      const category = filePath.split('/')[0];
      const filename = filePath.split('/')[1];
      await generateThumbnailIfMissing(category, filename);
    }
  } catch (err) {
    console.warn('Failed to generate thumbnail for upcoming video(s)', err && err.message);
  }
}

// global seed for deterministic pseudo-random generation (set once at startup)
const GLOBAL_SEED = crypto.randomBytes(4).readUInt32LE(0);

// user behavior: { "category/file.mp4": { watchTime: seconds, likes: 0/1 } }
let userBehavior = {};
let fileMap = {};
let categories = [];
let catalogKeySet = new Set();
const recentQueue = [];
const recentSet = new Set();
const recommender = require('./recommender');

// Persistence paths and helpers
const DATA_DIR = config.dataDir;
const RECENT_PATH = config.getRecentPath();
const BEHAVIOR_PATH = config.getBehaviorPath();

async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) { }
}

async function saveRecent() {
  try {
    await ensureDataDir();
    await fs.writeFile(RECENT_PATH, JSON.stringify({ queue: recentQueue }), 'utf8');
  } catch (e) { console.warn('Failed to save recent.json', e && e.message); }
}

async function saveBehavior() {
  try {
    await ensureDataDir();
    await fs.writeFile(BEHAVIOR_PATH, JSON.stringify(userBehavior), 'utf8');
  } catch (e) { console.warn('Failed to save behavior.json', e && e.message); }
}

async function ensureDataFiles() {
  await ensureDataDir();

  // Create missing data files with safe defaults.
  try {
    await fs.access(RECENT_PATH);
  } catch (e) {
    await fs.writeFile(RECENT_PATH, JSON.stringify({ queue: [] }), 'utf8');
  }

  try {
    await fs.access(BEHAVIOR_PATH);
  } catch (e) {
    await fs.writeFile(BEHAVIOR_PATH, JSON.stringify({}), 'utf8');
  }
}

async function loadPersistent() {
  try {
    await ensureDataFiles();
    try {
      const b = await fs.readFile(RECENT_PATH, 'utf8');
      const parsed = JSON.parse(b || '{}');
      const q = Array.isArray(parsed.queue) ? parsed.queue : [];
      recentQueue.length = 0;
      for (const k of q) { recentQueue.push(k); }
      recentSet.clear();
      for (const k of recentQueue) recentSet.add(k);
    } catch (e) {
      // Recreate/reset invalid file contents so subsequent runs stay healthy.
      await fs.writeFile(RECENT_PATH, JSON.stringify({ queue: [] }), 'utf8');
      recentQueue.length = 0;
      recentSet.clear();
    }

    try {
      const b2 = await fs.readFile(BEHAVIOR_PATH, 'utf8');
      const parsed2 = JSON.parse(b2 || '{}');
      // replace contents of userBehavior
      Object.keys(userBehavior).forEach(k=>delete userBehavior[k]);
      if (parsed2 && typeof parsed2 === 'object') Object.assign(userBehavior, parsed2);
    } catch (e) {
      await fs.writeFile(BEHAVIOR_PATH, JSON.stringify({}), 'utf8');
      Object.keys(userBehavior).forEach(k=>delete userBehavior[k]);
    }

    console.log('Loaded persistent state: recent=', recentQueue.length, 'behavior=', Object.keys(userBehavior).length);
  } catch (e) {
    console.warn('Failed loading persistent state', e && e.message);
  }
}

// Ensure persisted state is flushed on shutdown
process.on('SIGINT', () => {
  try {
    fsSync.writeFileSync(RECENT_PATH, JSON.stringify({ queue: recentQueue }), 'utf8');
    fsSync.writeFileSync(BEHAVIOR_PATH, JSON.stringify(userBehavior), 'utf8');
  } catch (e) { /* best-effort */ }
  process.exit(0);
});

function rebuildCatalogKeySet() {
  const next = new Set();
  for (const cat of Object.keys(fileMap || {})) {
    const files = fileMap[cat] || [];
    for (const file of files) next.add(`${cat}/${file}`);
  }
  catalogKeySet = next;
}

function pruneRecentAgainstCatalog() {
  if (!catalogKeySet.size) {
    recentQueue.length = 0;
    recentSet.clear();
    return;
  }

  const deduped = [];
  const seen = new Set();
  for (const key of recentQueue) {
    if (!catalogKeySet.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(key);
  }

  recentQueue.length = 0;
  recentSet.clear();
  for (const key of deduped) {
    recentQueue.push(key);
    recentSet.add(key);
  }
}

function resetSeenCycle() {
  recentQueue.length = 0;
  recentSet.clear();
  saveRecent().catch(() => {});
}

function ensureUnseenPool() {
  if (!catalogKeySet.size) return;
  if (recentSet.size >= catalogKeySet.size) {
    // Start a new cycle only after every available video has been shown once.
    resetSeenCycle();
  }
}

function collectUnseenItems() {
  const unseen = [];
  for (const cat of categories) {
    const files = fileMap[cat] || [];
    for (const file of files) {
      const key = `${cat}/${file}`;
      if (!recentSet.has(key)) unseen.push({ key, cat, file });
    }
  }
  return unseen;
}

// random number generator function
function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Populate fileMap by scanning the categories. Called periodically to
// pick up new files added to disk.
async function buildCache() {
  try {
    const entries = await fs.readdir(videosRoot, { withFileTypes: true });
    const cats = entries.filter(e => e.isDirectory()).map(d => d.name).sort();

    const map = {};
    for (const cat of cats) {
      try {
        const files = await fs.readdir(path.join(videosRoot, cat));
        const vids = files.filter(f => /\.(mp4|mov|webm|mkv|avi)$/i.test(f)).sort();
        if (vids.length) map[cat] = vids.slice();
      } catch (err) {
        console.warn('Error reading category', cat, err.message);
      }
    }

    fileMap = map;
    categories = Object.keys(fileMap);
    rebuildCatalogKeySet();
    pruneRecentAgainstCatalog();
    ensureUnseenPool();
    console.log(`Built file map with ${categories.length} categories.`);
    // update recommender index in background
    try { recommender.buildIndex(fileMap).catch(()=>{}); } catch (e) { }
  } catch (err) {
    console.error('Error building videos file map', err && err.message);
    fileMap = {};
    categories = [];
  }
}

// Generate posts for a given range [offset, offset+limit).
function generatePostsRange(offset, limit) {
  const out = [];
  if (!categories || categories.length === 0) return out;
  if (limit <= 0) return out;

  ensureUnseenPool();

  const unseen = collectUnseenItems();
  if (!unseen.length) return out;

  const take = Math.min(limit, unseen.length);
  const rnd = mulberry32((GLOBAL_SEED + offset + unseen.length) >>> 0);

  // Partial Fisher-Yates to sample without replacement.
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rnd() * (unseen.length - i));
    const tmp = unseen[i];
    unseen[i] = unseen[j];
    unseen[j] = tmp;
  }

  for (let i = 0; i < take; i++) {
    const { key, cat, file } = unseen[i];
    generateThumbnailIfMissing(cat, file);
    out.push(buildPost(cat, file));
    recordRecentKey(key);
  }

  // Pre-generate thumbnails for upcoming videos (next videos in the queue)
  generateNextThumbnailIfNeeded(out);

  return out;
}

function recordRecentKey(key) {
  if (!key || recentSet.has(key)) return;
  recentQueue.push(key);
  recentSet.add(key);
  saveRecent().catch(() => {});
}

function buildPost(cat, file) {
  const base = file.replace(/\.[^/.]+$/, '') + '.webp';
  return {
    videoUrl: `/videos/${encodeURIComponent(cat)}/${encodeURIComponent(file)}`,
    thumbnailUrl: `/videos/${encodeURIComponent(cat)}/${encodeURIComponent(base)}`,
    user: cat,
    caption: file,
    song: ''
  };
}

function pickRandomPost() {
  if (!categories || categories.length === 0) return null;
  ensureUnseenPool();
  const unseen = collectUnseenItems();
  if (!unseen.length) return null;
  const rnd = mulberry32((GLOBAL_SEED + Date.now() + unseen.length) >>> 0);
  const pick = unseen[Math.floor(rnd() * unseen.length)];
  return pick ? { key: pick.key, cat: pick.cat, file: pick.file } : null;
}

function pickNextItem(lastKey, action) {
  ensureUnseenPool();
  let item = recommender.recommendNext({ lastKey, action, userBehavior, recentSet, recentKeys: recentQueue });
  if (!item) {
    const fallback = pickRandomPost();
    if (!fallback) return null;
    item = { key: fallback.key, category: fallback.cat, file: fallback.file };
  }

  const key = item.key || `${item.category}/${item.file}`;
  const cat = item.category;
  const file = item.file;
  if (!cat || !file) return null;

  generateThumbnailIfMissing(cat, file);
  return { key, category: cat, file };
}

function generateNextPost(lastKey, action) {
  const item = pickNextItem(lastKey, action);
  if (!item) return null;
  recordRecentKey(item.key);
  return buildPost(item.category, item.file);
}

function makeContextSig(lastKey, action) {
  return `${lastKey || ''}::${action || ''}`;
}

let nextPrediction = null; // { contextSig, item }
let predictionInFlight = false;
let queuedPredictionContext = null;

async function runPredictionWorker() {
  if (predictionInFlight) return;
  predictionInFlight = true;
  try {
    while (queuedPredictionContext) {
      const ctx = queuedPredictionContext;
      queuedPredictionContext = null;
      const item = pickNextItem(ctx.lastKey, ctx.action);
      nextPrediction = item ? { contextSig: makeContextSig(ctx.lastKey, ctx.action), item } : null;
      await Promise.resolve();
    }
  } finally {
    predictionInFlight = false;
  }
}

function queuePrediction(lastKey, action) {
  queuedPredictionContext = { lastKey: lastKey || null, action: action || null };
  runPredictionWorker().catch(() => {});
}

function consumeOrGenerateNext(lastKey, action) {
  const contextSig = makeContextSig(lastKey, action);
  if (nextPrediction && nextPrediction.contextSig === contextSig && nextPrediction.item) {
    const item = nextPrediction.item;
    nextPrediction = null;
    recordRecentKey(item.key);
    return buildPost(item.category, item.file);
  }

  return generateNextPost(lastKey, action);
}

function parseCatalogKey(key) {
  if (!key || typeof key !== 'string') return null;
  const parts = key.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return null;
  const category = parts[0];
  const file = parts.slice(1).join('/');
  if (!category || !file) return null;
  return { category, file };
}

function resolveVideoPathFromKey(key) {
  const parsed = parseCatalogKey(key);
  if (!parsed) return null;
  const { category, file } = parsed;

  const fullPath = path.resolve(videosRoot, category, file);
  const rootPath = path.resolve(videosRoot);
  if (!fullPath.startsWith(rootPath)) return null;
  return fullPath;
}

function openVideoFolderForKey(key) {
  const fullPath = resolveVideoPathFromKey(key);
  if (!fullPath) return false;
  if (!fsSync.existsSync(fullPath)) return false;

  if (process.platform === 'win32') {
    const folder = path.dirname(fullPath);
    const child = spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  }

  const folder = path.dirname(fullPath);
  if (process.platform === 'darwin') {
    const child = spawn('open', [folder], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  }

  const child = spawn('xdg-open', [folder], { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

function getVideoMetadataForKey(key) {
  const fullPath = resolveVideoPathFromKey(key);
  if (!fullPath) return null;
  if (!fsSync.existsSync(fullPath)) return null;

  const st = fsSync.statSync(fullPath);
  const parsed = path.parse(fullPath);
  const keyParts = parseCatalogKey(key);
  const category = keyParts ? keyParts.category : '';

  const details = {
    Name: parsed.base,
    Category: category,
    FullPath: fullPath,
    Folder: parsed.dir,
    Extension: parsed.ext || '',
    SizeBytes: st.size,
    SizeMB: (st.size / (1024 * 1024)).toFixed(2),
    Created: st.birthtime,
    Modified: st.mtime,
    Accessed: st.atime,
    IsFile: st.isFile(),
    Device: st.dev,
    Inode: st.ino,
    Mode: st.mode,
    HardLinks: st.nlink,
    UID: st.uid,
    GID: st.gid,
    BlockSize: st.blksize,
    Blocks: st.blocks
  };

  return details;
}

// initial cache build and periodic refresh to avoid scanning on every request
// Load persisted state, then build cache and schedule periodic tasks
loadPersistent().then(() => {
  buildCache();
  setInterval(buildCache, 30 * 1000);
  // periodic flush of in-memory state
  setInterval(() => { saveRecent().catch(()=>{}); saveBehavior().catch(()=>{}); }, 30 * 1000);
});

// API: return paginated posts (infinite generator)
// The endpoint mixes regular posts with personalized recommendations
app.get('/api/posts', (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  ensureUnseenPool();

  // Generate base posts from the catalog
  const posts = generatePostsRange(offset, Math.max(0, limit - 4));

  // Get personalized recommendations based on user behavior
  // Recommendations are mixed in to provide adaptive content
  let recs = [];
  try { recs = recommender.recommend(userBehavior, recentSet, 6, recentQueue); } catch (e) { recs = []; }

  // Merge: put recommendations after regular posts
  const merged = posts.concat(recs);
  res.json({ total: Number.MAX_SAFE_INTEGER, posts: merged });
});

// API: return a single next post based on the last action
app.post('/api/next', (req, res) => {
  const { lastKey, action } = req.body || {};
  ensureUnseenPool();
  const next = consumeOrGenerateNext(lastKey, action);
  if (!next) return res.json({ post: null });
  res.json({ post: next });
});

// Queue a single background prediction based on latest behavior context.
app.post('/api/predict', (req, res) => {
  const { lastKey, action } = req.body || {};
  queuePrediction(lastKey, action);
  res.json({ ok: true });
});

// Open the folder containing the requested video in the OS file explorer.
app.post('/api/open-video-folder', (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'missing key' });

  try {
    const opened = openVideoFolderForKey(key);
    if (!opened) return res.status(404).json({ ok: false, error: 'video not found' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'failed to open folder' });
  }
});

// Return file metadata used by the comments drawer in the UI.
app.post('/api/video-metadata', (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'missing key' });

  try {
    const details = getVideoMetadataForKey(key);
    if (!details) return res.status(404).json({ ok: false, error: 'video not found' });
    return res.json({ ok: true, details });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'failed to load metadata' });
  }
});

// Track user watch/interaction events. body: { key: "Category/file.mp4", watchTime: seconds, action: 'like'|'skip' }
// This data is used for adaptive recommendations and personalization
app.post('/api/track', (req, res) => {
  const { key, watchTime = 0, action } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'missing key' });

  // Initialize behavior tracking for new videos
  if (!userBehavior[key]) userBehavior[key] = { watchTime: 0, likes: 0, views: 0, skips: 0, lastSeenAt: 0 };
  if (userBehavior[key].views === undefined) userBehavior[key].views = 0;
  if (userBehavior[key].skips === undefined) userBehavior[key].skips = 0;
  userBehavior[key].lastSeenAt = Date.now();
  
  // Accumulate watch time
  userBehavior[key].watchTime += Number(watchTime || 0);
  
  // Track likes and skips
  if (action === 'like') userBehavior[key].likes = (userBehavior[key].likes || 0) + 1;
  if (action === 'watch' || action === 'complete') userBehavior[key].views = (userBehavior[key].views || 0) + 1;
  if (action === 'skip') {
    userBehavior[key].watchTime = Math.max(0, userBehavior[key].watchTime - 1);
    userBehavior[key].skips = (userBehavior[key].skips || 0) + 1;
  }

  // persist behavior (best-effort, non-blocking)
  saveBehavior().catch(()=>{});

  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
