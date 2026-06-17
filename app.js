const feed = document.getElementById('feed');

let loading = false;
let audioEnabled = false;
let lastDecision = null;
const INITIAL_PRELOAD_POSTS = 4;

function warmThumbnail(section){
  if(!section || section._thumbWarmStarted) return;
  section._thumbWarmStarted = true;

  const src = section.dataset.videoUrl;
  const thumb = section.dataset.thumb;

  if(thumb){
    const img = new Image();
    img.decoding = 'async';
    img.src = thumb;
    img.onerror = () => {
      getVideoThumbnail(src, 640)
        .then((data) => { section.dataset.thumb = data; })
        .catch(() => {});
    };
    return;
  }

  getVideoThumbnail(src, 640)
    .then((data) => { section.dataset.thumb = data; })
    .catch(() => {});
}

// Global audio enable button (single user gesture to allow autoplay with sound)
function createGlobalAudioButton(){
  const btn = document.createElement('button');
  btn.id = 'enable-audio';
  btn.textContent = 'Enable Audio';
  btn.style.position = 'fixed';
  btn.style.right = '12px';
  btn.style.top = '12px';
  btn.style.zIndex = 9999;
  btn.style.padding = '8px 12px';
  btn.style.background = '#111';
  btn.style.color = '#fff';
  btn.style.border = 'none';
  btn.style.borderRadius = '6px';
  btn.style.cursor = 'pointer';
  btn.addEventListener('click', async ()=>{
    try{
      // create and persist AudioContext to unlock audio
      if(!window.__globalAudioCtx && (window.AudioContext || window.webkitAudioContext)){
        const AC = window.AudioContext || window.webkitAudioContext;
        window.__globalAudioCtx = new AC();
        try{ await window.__globalAudioCtx.resume(); }catch(e){}
      } else if(window.__globalAudioCtx){
        try{ await window.__globalAudioCtx.resume(); }catch(e){}
      }

      audioEnabled = true;
      btn.style.display = 'none';

      // unmute and try to play any currently attached videos
      document.querySelectorAll('video').forEach(v=>{
        try{ v.muted = false; v.play().catch(()=>{}); }catch(e){}
      });

      // small delay to allow videos attached very shortly after to unmute/play
      setTimeout(()=>{
        document.querySelectorAll('video').forEach(v=>{ try{ v.muted = false; }catch(e){} });
      }, 200);
    }catch(e){ console.warn('Enable audio failed', e); }
  });
  document.body.appendChild(btn);
}

function makeMeta(p){
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<div class="user">${p.user}</div><div class="caption">${p.caption}</div><div class="music">♪ ${p.song || ''}</div>`;
  return meta;
}

// generate a thumbnail dataURL for a video source by drawing a frame to canvas
async function getVideoThumbnail(src, width = 480){
  return new Promise((resolve, reject) => {
    try{
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.preload = 'metadata';
      v.muted = true;
      v.src = src;

      const cleanup = () => { try{ v.src = ''; v.remove(); }catch(e){} };

      const onError = ()=>{ cleanup(); reject(new Error('thumbnail load error')); };
      v.addEventListener('error', onError, { once: true });

      v.addEventListener('loadeddata', async () => {
        // try to seek a little into the video to avoid black frames at 0
        const seekTo = Math.min(0.1, (v.duration || 0) * 0.1 || 0.1);
        const doSeek = () => {
          const canvas = document.createElement('canvas');
          const ratio = v.videoWidth ? (v.videoHeight ? v.videoWidth / v.videoHeight : 16/9) : 16/9;
          canvas.width = width;
          canvas.height = Math.round(width / ratio);
          try{
            const ctx = canvas.getContext('2d');
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const data = canvas.toDataURL('image/jpeg', 0.7);
            cleanup();
            resolve(data);
          }catch(e){
            cleanup();
            reject(e);
          }
        };

        // some browsers require waiting for seek to complete
        try{
          v.currentTime = seekTo;
          v.addEventListener('seeked', doSeek, { once: true });
          // fallback if seeked doesn't fire quickly
          setTimeout(() => { if(!v.paused) doSeek(); }, 800);
        }catch(e){ doSeek(); }
      }, { once: true });
    }catch(err){ reject(err); }
  });
}

function createPlaceholder(p){
  const section = document.createElement('section');
  section.className = 'post';
  section.dataset.videoUrl = p.videoUrl;
  if(p.thumbnailUrl) section.dataset.thumb = p.thumbnailUrl;
  section.dataset.user = p.user;
  section.dataset.caption = p.caption;
  section.dataset.song = p.song || '';

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.appendChild(makeMeta(p));

  const actions = document.createElement('div');
  actions.className = 'actions';
  const likeWrap = document.createElement('div');
  likeWrap.style.textAlign = 'center';
  const likeBtn = document.createElement('button');
  likeBtn.className = 'action like-btn';
  likeBtn.textContent = '♥';
  const likeCount = document.createElement('div');
  likeCount.className = 'like-count';
  likeCount.textContent = '0';
  likeWrap.appendChild(likeBtn);
  likeWrap.appendChild(likeCount);

  const commentBtn = document.createElement('button');
  commentBtn.className = 'action';
  commentBtn.textContent = '💬';
  commentBtn.title = 'Show file data';
  const shareBtn = document.createElement('button');
  shareBtn.className = 'action';
  shareBtn.textContent = '⤴';
  shareBtn.title = 'Open video folder';

  actions.appendChild(likeWrap);
  actions.appendChild(commentBtn);
  actions.appendChild(shareBtn);

  const unmuteBtn = document.createElement('button');
  unmuteBtn.className = 'unmute';
  unmuteBtn.textContent = '🔊';
  unmuteBtn.title = 'Unmute';
  unmuteBtn.style.display = 'none';

  overlay.appendChild(actions);
  overlay.appendChild(unmuteBtn);

  const commentsPanel = document.createElement('div');
  commentsPanel.className = 'comments-panel';
  const commentsHeader = document.createElement('div');
  commentsHeader.className = 'comments-header';
  commentsHeader.textContent = 'File Data';
  const commentsList = document.createElement('div');
  commentsList.className = 'comments-list';
  commentsPanel.appendChild(commentsHeader);
  commentsPanel.appendChild(commentsList);
  overlay.appendChild(commentsPanel);

  section.appendChild(overlay);

  // basic interactions
  let liked = false;
  let commentsOpen = false;
  let metadataLoaded = false;
  let singleTapTimer = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const renderComments = (detailsObj) => {
    const rows = Object.entries(detailsObj || {});
    if (!rows.length) {
      commentsList.innerHTML = '<div class="comment-row"><div class="comment-user">System</div><div class="comment-text">No metadata found.</div></div>';
      return;
    }

    commentsList.innerHTML = rows.map(([k, v]) => (
      `<div class="comment-row"><div class="comment-user">${esc(k)}</div><div class="comment-text">${esc(v)}</div></div>`
    )).join('');
  };

  const closeComments = () => {
    commentsOpen = false;
    commentsPanel.classList.remove('open');
  };

  const openComments = async () => {
    commentsOpen = true;
    commentsPanel.classList.add('open');
    if (metadataLoaded) return;

    commentsList.innerHTML = '<div class="comment-row"><div class="comment-user">Loading</div><div class="comment-text">Fetching file data...</div></div>';
    const key = section.dataset.user + '/' + section.dataset.caption;
    try {
      const res = await fetch('/api/video-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const payload = await res.json();
      if (payload && payload.ok && payload.details) {
        renderComments(payload.details);
        metadataLoaded = true;
      } else {
        commentsList.innerHTML = '<div class="comment-row"><div class="comment-user">Error</div><div class="comment-text">Could not load file data.</div></div>';
      }
    } catch (e) {
      commentsList.innerHTML = '<div class="comment-row"><div class="comment-user">Error</div><div class="comment-text">Could not load file data.</div></div>';
    }
  };
  const burstLike = (x, y) => {
    const rect = section.getBoundingClientRect();
    const originX = Number.isFinite(x) ? Math.round(x - rect.left) : Math.round(rect.width * 0.5);
    const originY = Number.isFinite(y) ? Math.round(y - rect.top) : Math.round(rect.height * 0.45);

    const count = 6;
    for (let i = 0; i < count; i++) {
      const heart = document.createElement('div');
      heart.className = 'like-burst';
      heart.textContent = '♥';
      heart.style.left = `${originX}px`;
      heart.style.top = `${originY}px`;
      heart.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 90)}px`);
      heart.style.setProperty('--dy', `${-55 - Math.round(Math.random() * 70)}px`);
      heart.style.setProperty('--delay', `${Math.round(Math.random() * 70)}ms`);
      heart.style.setProperty('--scale', `${(0.7 + Math.random() * 0.55).toFixed(2)}`);
      section.appendChild(heart);
      requestAnimationFrame(() => heart.classList.add('show'));
      setTimeout(() => { try { heart.remove(); } catch (e) {} }, 850);
    }
  };

  const setLikedState = (nextLiked, triggerPulse = true) => {
    liked = !!nextLiked;
    likeBtn.classList.toggle('liked', liked);
    likeCount.textContent = liked ? '1' : '0';
    section.dataset.liked = liked ? '1' : '0';
    if (liked && triggerPulse) {
      likeBtn.classList.remove('like-pop');
      void likeBtn.offsetWidth;
      likeBtn.classList.add('like-pop');
      setTimeout(() => likeBtn.classList.remove('like-pop'), 260);
    }
    // report like to server
    try{ fetch('/api/track', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ key: section.dataset.user + '/' + section.dataset.caption, action: liked ? 'like' : undefined, watchTime: 0 }) }); }catch(e){}
  };

  likeBtn.addEventListener('click', ()=>{
    setLikedState(!liked, true);
  });

  commentBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (commentsOpen) closeComments();
    else openComments().catch(() => {});
  });

  commentsPanel.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  shareBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const key = section.dataset.user + '/' + section.dataset.caption;
    try {
      fetch('/api/open-video-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
    } catch (err) {}
  });

  // single tap toggles play/pause (deferred so double-tap can cancel it)
  section.addEventListener('click', (e)=>{
    if(e.target.tagName.toLowerCase() === 'button') return;
    if (commentsOpen) {
      closeComments();
      return;
    }
    if (singleTapTimer) clearTimeout(singleTapTimer);
    singleTapTimer = setTimeout(() => {
      const v = section.querySelector('video');
      if(!v) return;
      if(v.paused) v.play(); else v.pause();
      singleTapTimer = null;
    }, 220);
  });

  // dbl to like with TikTok-style burst
  section.addEventListener('dblclick', (e)=> {
    if (singleTapTimer) {
      clearTimeout(singleTapTimer);
      singleTapTimer = null;
    }
    burstLike(e.clientX, e.clientY);
    if (!liked) setLikedState(true, true);
  });

  return section;
}

// play with retry to handle transient autoplay failures
async function playWithRetry(v, tries = 3){
  for(let i=0;i<tries;i++){
    try{
      await v.play();
      return true;
    }catch(e){
      await new Promise(r=>setTimeout(r, 300 * (i+1)));
    }
  }
  return false;
}

function attachVideoToSection(section){
  if(section._hasVideo) return;
  section._hasVideo = true;

  const src = section.dataset.videoUrl;

  // create thumbnail img first to avoid black screen
  const thumbImg = document.createElement('img');
  thumbImg.className = 'thumb';
  thumbImg.style.width = '100%';
  thumbImg.style.display = 'block';
  thumbImg.style.objectFit = 'cover';
  thumbImg.style.transition = 'opacity 300ms ease';
  thumbImg.style.opacity = '1';
  section.insertBefore(thumbImg, section.firstChild);

  // generate thumbnail asynchronously; ignore errors
  if(section.dataset.thumb){
    thumbImg.src = section.dataset.thumb;
    thumbImg.onerror = ()=>{ thumbImg.style.background = '#111'; };
  } else {
    getVideoThumbnail(src, 640).then(data => { thumbImg.src = data; }).catch(()=>{ thumbImg.style.background = '#111'; });
  }

  const vid = document.createElement('video');
  vid.setAttribute('playsinline','');
  vid.setAttribute('loop','');
  vid.preload = 'auto';
  // start muted unless user explicitly enabled audio
  vid.muted = !audioEnabled;
  vid.src = src;
  vid.style.width = '100%';
  vid.style.display = 'block';
  vid.style.objectFit = 'cover';
  vid.style.transition = 'opacity 300ms ease';
  vid.style.opacity = '0';

  vid.addEventListener('error', ()=>{
    // try a cache-busting reload if playback fails
    vid.src = src + (src.includes('?') ? '&' : '?') + 'cb=' + Date.now();
  });

  vid.addEventListener('stalled', ()=>{ /* allow IntersectionObserver to retry via playWithRetry */ });

  // show unmute when user interacts with the section (if audio not globally enabled)
  const unmute = section.querySelector('.unmute');
  if(!audioEnabled){
    unmute.style.display = 'block';
    unmute.addEventListener('click', (e)=>{
      e.stopPropagation();
      // a user gesture — safe to unmute
      vid.muted = !vid.muted;
      unmute.textContent = vid.muted ? '🔇' : '🔊';
      playWithRetry(vid, 2);
    });
  } else {
    // hide per-section unmute when global audio allowed
    unmute.style.display = 'none';
  }

  // insert video at top of section (above thumbnail)
  section.insertBefore(vid, thumbImg);

  // Watch time tracking for adaptive recommendations
  section._watchAccum = section._watchAccum || 0;
  let lastTime = 0;
  const sendAccum = () => {
    const key = section.dataset.user + '/' + section.dataset.caption;
    const toSend = Math.floor(section._watchAccum);
    if(toSend > 0){
      try{ fetch('/api/track',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key, watchTime: toSend }) }); }catch(e){}
      section._watchAccum = 0;
    }
  };

  vid.addEventListener('timeupdate', ()=>{
    try{
      const t = vid.currentTime || 0;
      if(lastTime && t > lastTime){
        section._watchAccum += (t - lastTime);
      }
      lastTime = t;
      // send periodically when accumulated > 5s
      if(section._watchAccum >= 5){ sendAccum(); }
    }catch(e){}
  });

  vid.addEventListener('pause', ()=>{ sendAccum(); });
  vid.addEventListener('ended', ()=>{ sendAccum(); section._ended = true; });

  // reveal the first decoded frame as soon as it's available
  let firstFrameShown = false;
  const showFirstFrame = () => {
    if (firstFrameShown) return;
    firstFrameShown = true;
    requestAnimationFrame(() => { vid.style.opacity = '1'; });
    thumbImg.style.opacity = '0';
    setTimeout(() => { try { thumbImg.remove(); } catch (e) {} }, 220);
  };

  vid.addEventListener('loadeddata', showFirstFrame, { once: true });

  // start playback right after first frame can be shown
  const onCanPlay = async () => {
    showFirstFrame();
    try { await playWithRetry(vid, 2); } catch (e) {}
  };

  vid.addEventListener('canplay', onCanPlay, { once: true });

  // ensure playback attempt starts promptly
  playWithRetry(vid, 2).catch(() => {});

  // pause when leaving viewport handled by observer
}

function detachVideoFromSection(section){
  const watchedSeconds = Number(section._watchAccum || 0);
  const v = section.querySelector('video');
  if(v){
    try{ v.pause(); }catch(e){}
    // fade out for smooth transition then remove
    v.style.opacity = '0';
    setTimeout(()=>{ try{ v.remove(); }catch(e){} }, 350);
    // send any remaining watch time when detaching
    try{
      const key = section.dataset.user + '/' + section.dataset.caption;
      const toSend = Math.floor(section._watchAccum || 0);
      if(toSend > 0){ fetch('/api/track',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key, watchTime: toSend }) }); }
      section._watchAccum = 0;
    }catch(e){}
  }
  section._hasVideo = false;
  const unmute = section.querySelector('.unmute');
  if(unmute) unmute.style.display = 'none';

  if (!section._actionSent) {
    const key = section.dataset.user + '/' + section.dataset.caption;
    const liked = section.dataset.liked === '1';
    let action = 'skip';
    if (section._ended) action = 'complete';
    else if (liked) action = 'like';
    else if (watchedSeconds >= 6) action = 'watch';

    lastDecision = { lastKey: key, action };
    try {
      fetch('/api/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastDecision)
      });
    } catch (e) {}
    section._actionSent = true;
  }
}

// Observer: when a placeholder intersects, attach video; when leaves, detach
const viewOptions = { root: feed, threshold: 0.6 };
const viewObserver = new IntersectionObserver((entries)=>{
  entries.forEach(entry=>{
    const sec = entry.target;
    if(entry.isIntersecting){
      attachVideoToSection(sec);
      const v = sec.querySelector('video');
      if(v) playWithRetry(v, 2);
    } else {
      // keep a small buffer: detach only if very far (not intersecting)
      detachVideoFromSection(sec);
    }
  });
}, viewOptions);

// sentinel for loading more pages
const sentinel = document.createElement('div');
sentinel.id = 'sentinel';
feed.appendChild(sentinel);
const sentinelObserver = new IntersectionObserver((entries)=>{
  entries.forEach(e=>{ if(e.isIntersecting) loadNext(); });
}, {root: feed, threshold: 0});
sentinelObserver.observe(sentinel);

// create global audio enable control
createGlobalAudioButton();

async function loadNext(){
  if(loading) return;
  loading = true;
  try{
    const payload = lastDecision || {};
    lastDecision = null;
    const res = await fetch('/api/next', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    const post = data && data.post ? data.post : null;
    if(!post){
      feed.innerHTML = '<div style="padding:20px;color:#ddd">No videos found. Please configure VIDEO_SOURCE_DIR to point to your categorized videos folder. See README.md for setup instructions.</div>';
      return;
    }

    const ph = createPlaceholder(post);
    feed.insertBefore(ph, sentinel);
    viewObserver.observe(ph);
    warmThumbnail(ph);
  }catch(err){
    console.error('Failed to load posts', err);
  } finally { loading = false; }
}

async function primeInitialFeed(){
  for(let i = 0; i < INITIAL_PRELOAD_POSTS; i++){
    await loadNext();
  }
}

// kick off and warm first posts before user scrolls
primeInitialFeed().catch(()=>{});

// Desktop wheel navigation: move exactly one post per wheel gesture
let wheelLocked = false;
const WHEEL_LOCK_MS = 420;

async function wheelNavigate(deltaY) {
  if (wheelLocked) return;
  if (Math.abs(deltaY) < 2) return;

  const direction = deltaY > 0 ? 1 : -1;
  const posts = Array.from(feed.querySelectorAll('.post'));
  if (!posts.length) return;

  const vh = feed.clientHeight || window.innerHeight || 1;
  const currentIndex = Math.max(0, Math.min(posts.length - 1, Math.round((feed.scrollTop || 0) / vh)));
  let targetIndex = currentIndex + direction;

  if (targetIndex < 0) targetIndex = 0;

  if (targetIndex >= posts.length && direction > 0) {
    await loadNext();
  }

  const updatedPosts = Array.from(feed.querySelectorAll('.post'));
  if (!updatedPosts.length) return;
  if (targetIndex >= updatedPosts.length) targetIndex = updatedPosts.length - 1;

  const target = updatedPosts[targetIndex];
  if (!target) return;

  wheelLocked = true;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => { wheelLocked = false; }, WHEEL_LOCK_MS);
}

window.addEventListener('wheel', (e) => {
  // ignore pinch-zoom gestures and keep normal behavior for modifier-key scroll
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const openComments = e.target && e.target.closest && e.target.closest('.comments-panel.open');
  if (openComments) {
    // allow native scroll inside comments drawer without switching videos
    return;
  }

  e.preventDefault();
  wheelNavigate(e.deltaY).catch(() => {});
}, { passive: false });

