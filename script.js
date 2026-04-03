(function () {
  // --- 1. DEVICE DETECTION & PLAYER SWITCHER ---
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const playerContainer = document.querySelector('.radio-player');

  // If mobile, rewrite the player structure before the rest of the script runs
 if (isMobile) {
    playerContainer.classList.add('mobile-version');
    playerContainer.innerHTML = `
      <div id="album-art" class="mobile-art-btn">
        <div class="play-overlay" style="opacity:0.3;">♪</div>
        <span class="placeholder-note" style="font-size:2rem;opacity:0.3;position:absolute;">♪</span>
      </div>
      
      <div class="track-info">
        <div id="song-title">Loading...</div>
        <div id="artist-name">If the wait time is irregular, please try again later and email us at support@qwrt.online</div>
      </div>

      <div class="mobile-controls">
        <button id="mute-btn" aria-label="Unmute">
          <img id="mute-icon" src="muted.png" alt="Muted" width="22" height="22" />
        </button>
        <input type="range" id="volume" min="0" max="100" value="80">
      </div>
    `;
  }
  // --- 2. CORE VARIABLES ---
  const audio           = document.getElementById('radio-stream');
  const songTitleEl     = document.getElementById('song-title');
  const artistNameEl    = document.getElementById('artist-name');
  const albumArtEl      = document.getElementById('album-art');
  const volumeInput     = document.getElementById('volume');
  
  // Elements that only exist on Desktop
  const playBtn         = document.getElementById('play-btn');
  const volumeDisplay   = document.getElementById('volume-display');
  const progressContainer = document.getElementById('progress-container');
  const progressFill      = document.getElementById('progress-fill');
  const timeElapsedEl     = document.getElementById('time-elapsed');
  const timeDurationEl    = document.getElementById('time-duration');

  // Elements that only exist on Mobile
  const muteBtn         = document.getElementById('mute-btn');
  const muteIcon        = document.getElementById('mute-icon');

  const STREAM_URL = "https://stream.qwrt.online/listen/qwrt_radio/radio.mp3";
  const API_URL    = "https://stream.qwrt.online/api/nowplaying/qwrt_radio";

  function updateMuteIcon() {
    if (!muteIcon) return;
    if (audio.muted) {
      muteIcon.src = 'muted.png';
      muteIcon.alt = 'Muted';
      muteBtn && muteBtn.setAttribute('aria-label', 'Unmute');
    } else {
      muteIcon.src = 'unmuted.png';
      muteIcon.alt = 'Unmuted';
      muteBtn && muteBtn.setAttribute('aria-label', 'Mute');
    }
  }

  let isPlaying = false, retryCount = 0, metadataInterval = null, wakeLock = null;
  let lastMetadata = { title:'', artist:'', art:'' };
  let currentElapsed = 0, currentDuration = 0, localProgressTimer = null;

  const DEFAULT_ART = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="%23f0f0f0"/><text x="50%" y="50%" font-family="Arial" font-size="200" fill="%23cccccc" text-anchor="middle" dy=".3em">♪</text></svg>';

  // --- 3. AUTO-PLAY BUT MUTED LOGIC ---
  if (isMobile) {
    audio.muted = true; // mobile autoplay always muted
  } else {
    audio.muted = false; // desktop should not mute by default
  }

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  function updateProgressUI() {
    // Only run if we are on desktop
    if (!progressContainer || currentDuration <= 0) {
      if (progressContainer) progressContainer.style.display = 'none';
      return;
    }
    progressContainer.style.display = 'flex';
    const percent = Math.min((currentElapsed / currentDuration) * 100, 100);
    progressFill.style.width = percent + '%';
    timeElapsedEl.textContent = formatTime(currentElapsed);
    timeDurationEl.textContent = formatTime(currentDuration);
  }

  function startLocalProgress() {
    if (localProgressTimer) clearInterval(localProgressTimer);
    localProgressTimer = setInterval(() => {
      if (currentDuration > 0 && currentElapsed < currentDuration) {
        currentElapsed++;
        updateProgressUI();
      }
    }, 1000);
  }

  function fitText(el, text, baseRem, minRem) {
    const len = (text || '').length;
    const size = len <= 20 ? baseRem : Math.max(minRem, baseRem - (len - 20) * 0.028);
    el.style.fontSize = size + 'rem';
  }

  function togglePlay() {
    if (audio.paused) {
      audio.src = STREAM_URL;
      audio.load();
      audio.play().then(() => {
        isPlaying = true; updateUIState(true);
        startMetadataService(); acquireWakeLock(); setupMediaSession();
      }).catch(() => { isPlaying = false; updateUIState(false); });
    } else {
      audio.pause(); isPlaying = false; updateUIState(false);
      stopMetadataService(); releaseWakeLock();
    }
  }

  function updateUIState(playing) {
    const icon = playing ? '❚❚' : '▶';
    // Update Desktop Button
    if (playBtn) {
      playBtn.innerHTML = icon;
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      playBtn.style.paddingLeft = playing ? '0' : '5px';
    }
    // Do not update mobile overlay as mobile has permanent autoplay+mute behavior
  }

  volumeInput.addEventListener('input', (e) => {
    audio.volume = e.target.value / 100;
    if (volumeDisplay) volumeDisplay.textContent = e.target.value + '%';
    // Unmute if user slides volume
    if (audio.volume > 0 && audio.muted) {
      audio.muted = false;
      updateMuteIcon();
      if (audio.paused) {
        audio.play().catch(() => {});
      }
    }
  });

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      const wasMuted = audio.muted;
      audio.muted = !audio.muted;
      updateMuteIcon();
      if (wasMuted && !audio.muted) {
        // When unmuting, ensure playback is active
        audio.play().catch(() => {});
      }
    });
  }

  updateMuteIcon();

  function updateMetadata(title, artist, artUrl) {
    if (lastMetadata.title === title && lastMetadata.artist === artist && lastMetadata.art === artUrl) return;
    lastMetadata = { title, artist, art: artUrl };

    const t = title  || 'Fetching metadata...';
    const a = artist || 'If the wait time is irregular, please try again later and email us at support@qwrt.online';

    songTitleEl.textContent  = t;
    artistNameEl.textContent = a;
    
    // Fit text looks different on mobile vs desktop
    const titleSize = isMobile ? 1.2 : 2.1;
    const artistSize = isMobile ? 0.9 : 1.45;
    fitText(songTitleEl,  t, titleSize, 0.9);
    fitText(artistNameEl, a, artistSize, 0.75);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = artUrl || DEFAULT_ART;
    img.onload = () => {
      if (isMobile) {
        albumArtEl.innerHTML = '<div class="play-overlay" style="opacity:0.3;">♪</div>';
      } else {
        albumArtEl.innerHTML = '';
      }
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.className = 'loaded';
      albumArtEl.appendChild(img);
    };
    img.onerror = () => { 
    };
  }

  // ... (setupMediaSession, fetchMetadata, startMetadataService remain the same) ...

  function setupMediaSession() {
    if (!('mediaSession' in navigator) || !lastMetadata.title) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: lastMetadata.title || 'QWRT Radio',
        artist: lastMetadata.artist || 'If the wait time is irregular, please try again later and email us at support@qwrt.online',
        album: 'QWRT Radio',
        artwork: [{ src: lastMetadata.art || DEFAULT_ART, sizes:'512x512', type:'image/jpeg' }]
      });
      navigator.mediaSession.playbackState = 'playing';
      navigator.mediaSession.setActionHandler('play',  () => { if (audio.paused) audio.play(); });
      navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); });
      navigator.mediaSession.setActionHandler('stop',  () => { audio.pause(); isPlaying = false; updateUIState(false); });
    } catch(e) {}
  }

  async function fetchMetadata() {
    try {
      const res  = await fetch(`${API_URL}?cb=${Date.now()}`, { mode:'cors', cache:'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const np   = data.now_playing;
      
      if (np) { 
        currentElapsed = np.elapsed || 0;
        currentDuration = np.duration || 0;
        updateProgressUI();
        if (np.song) {
          updateMetadata(np.song.title, np.song.artist, np.song.art); 
          setupMediaSession();
        }
      }
    } catch(e) { console.warn("Metadata fetch failed:", e); }
  }

  function startMetadataService() { 
    fetchMetadata(); 
    if (!metadataInterval) metadataInterval = setInterval(fetchMetadata, 10000); 
    startLocalProgress(); 
  }
  
  function stopMetadataService()  { 
    if (metadataInterval) { clearInterval(metadataInterval); metadataInterval = null; } 
    if (localProgressTimer) { clearInterval(localProgressTimer); localProgressTimer = null; }
  }

  audio.addEventListener('playing', () => { updateUIState(true); retryCount = 0; });
  audio.addEventListener('error',   () => {
    updateUIState(false);
    if (retryCount < 5) { retryCount++; setTimeout(() => { audio.load(); audio.play().catch(()=>{}); }, 3000 * retryCount); }
  });

  async function acquireWakeLock() {
    if ('wakeLock' in navigator) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch(e){} }
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().then(() => { wakeLock = null; }); } }

  // Assign togglePlay only on desktop. Mobile uses muted autoplay + mute/unmute toggle.
  if (!isMobile && playBtn) {
    playBtn.addEventListener('click', togglePlay);
  }
  
  document.addEventListener('keydown', (e) => {
    if (!isMobile && e.code === 'Space' && e.target.tagName !== 'INPUT') { 
      e.preventDefault(); 
      togglePlay(); 
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchMetadata();
  });

  audio.volume = parseInt(volumeInput.value) / 100;

  // Attempt mobile autoplay (muted autoplay is allowed in modern browsers)
  if (isMobile) {
    audio.src = STREAM_URL;
    audio.load();
    audio.play().then(() => {
      isPlaying = true;
      updateUIState(true);
      startMetadataService();
      acquireWakeLock();
      setupMediaSession();
    }).catch(err => {
      // Autoplay may be blocked by some browsers; user interaction will still work.
      console.warn('Autoplay blocked or unavailable:', err);
    });
  }

  fetchMetadata();
  startLocalProgress();
  
  // Load pages from JSON and set up navigation
  async function loadPages() {
    let contentData = {};
    try {
      const response = await fetch('pages.json?v=' + Date.now());
      if (!response.ok) throw new Error('Failed to load pages.json');
      contentData = await response.json();
    } catch (error) {
      console.error('Error loading pages:', error);
      // No fallback - if JSON fails, nav will be empty
      return;
    }

    const textNav = document.querySelector('.text-nav');
    const dynHeading = document.getElementById('dyn-heading');
    const dynSub = document.getElementById('dyn-sub');
    const dynBody = document.getElementById('dyn-body');

    // Generate nav items dynamically
    const pageKeys = Object.keys(contentData);
    pageKeys.forEach((key, index) => {
      const navItem = document.createElement('a');
      navItem.href = '#';
      navItem.className = 'nav-item';
      navItem.setAttribute('data-target', key);
      // Capitalize first letter for display
      navItem.textContent = key.charAt(0).toUpperCase() + key.slice(1);
      if (index === 0) navItem.classList.add('active'); // First page active
      textNav.appendChild(navItem);
    });

    // Set up click handlers for nav items
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        navItems.forEach(nav => nav.classList.remove('active'));
        item.classList.add('active');
        const target = item.getAttribute('data-target');
        if (contentData[target]) {
          dynHeading.textContent = contentData[target].heading;
          if (dynSub) dynSub.textContent = contentData[target].sub || "";
          dynBody.textContent = contentData[target].body;
        }
      });
    });

    // Load the first page by default
    if (pageKeys.length > 0) {
      const firstKey = pageKeys[0];
      dynHeading.textContent = contentData[firstKey].heading;
      if (dynSub) dynSub.textContent = contentData[firstKey].sub || "";
      dynBody.textContent = contentData[firstKey].body;
    }
  }

  loadPages();

})();
