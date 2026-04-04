(function () {

  // --- 1. DEVICE DETECTION & PLAYER SWITCHER ---
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
  const playerContainer = document.querySelector('.radio-player');

  if (isMobile) {
    playerContainer.classList.add('mobile-version');
    playerContainer.innerHTML = `
      <div id="album-art" class="mobile-art-btn">
        <div class="play-overlay" style="opacity:0.3;">♪</div>
        <span
          class="placeholder-note"
          style="font-size:2rem;opacity:0.3;position:absolute;"
        >♪</span>
      </div>

      <div class="track-info">
        <div id="song-title">Loading...</div>
        <div id="artist-name">
          If the wait time is irregular, please try again later
          and email us at support@qwrt.online
        </div>
      </div>

      <div class="mobile-controls">
        <button id="mute-btn" aria-label="Unmute">
          <img id="mute-icon" src="muted.png" alt="Muted" width="22" height="22" />
        </button>
        <input type="range" id="volume" min="0" max="100" value="80" />
      </div>
    `;
  }

  // --- 2. CORE VARIABLES ---
  const audio             = document.getElementById('radio-stream');
  const songTitleEl       = document.getElementById('song-title');
  const artistNameEl      = document.getElementById('artist-name');
  const albumArtEl        = document.getElementById('album-art');
  const volumeInput       = document.getElementById('volume');

  // Desktop-only elements
  const playBtn           = document.getElementById('play-btn');
  const volumeDisplay     = document.getElementById('volume-display');
  const progressContainer = document.getElementById('progress-container');
  const progressFill      = document.getElementById('progress-fill');
  const timeElapsedEl     = document.getElementById('time-elapsed');
  const timeDurationEl    = document.getElementById('time-duration');

  // Mobile-only elements
  const muteBtn  = document.getElementById('mute-btn');
  const muteIcon = document.getElementById('mute-icon');

  const STREAM_URL = 'https://stream.qwrt.online/listen/qwrt_radio/radio.mp3';
  const API_URL    = 'https://stream.qwrt.online/api/nowplaying/qwrt_radio';

  const DEFAULT_ART = [
    'data:image/svg+xml,',
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">',
    '<rect width="512" height="512" fill="%23f0f0f0"/>',
    '<text x="50%" y="50%" font-family="Arial" font-size="200" fill="%23cccccc"',
    ' text-anchor="middle" dy=".3em">♪</text>',
    '</svg>',
  ].join('');

  // Persistent image element — reused on every metadata update to avoid GC churn
  const currentArtImg = new Image();
  currentArtImg.crossOrigin = 'anonymous';
  currentArtImg.style.cssText = 'width:100%;height:100%;object-fit:cover;';
  currentArtImg.className = 'loaded';

  let isPlaying       = false;
  let retryCount      = 0;
  let metadataInterval = null;
  let wakeLock        = null;
  let lastMetadata    = { title: '', artist: '', art: '' };
  let currentElapsed  = 0;
  let currentDuration = 0;
  let localProgressTimer = null;

  // --- 3. MUTE ICON HELPER ---
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

  // Mobile autoplay must start muted; desktop unmuted
  audio.muted = isMobile;

  // --- 4. FORMATTING HELPERS ---
  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  // fitText: guard with data-fit so text layout only recalculates when text changes
  function fitText(el, text, baseRem, minRem) {
    if (el.dataset.fit === text) return;        // nothing changed — skip
    el.dataset.fit = text;
    const len  = (text || '').length;
    const size = len <= 20
      ? baseRem
      : Math.max(minRem, baseRem - (len - 20) * 0.028);
    el.style.fontSize = size + 'rem';
  }

  // --- 5. PROGRESS BAR ---
  // Debounce: batch rapid calls into a single rAF
  let progressRafId = null;
  function updateProgressUI() {
    if (progressRafId) return;
    progressRafId = requestAnimationFrame(() => {
      progressRafId = null;
      if (!progressContainer || currentDuration <= 0) {
        if (progressContainer) progressContainer.style.display = 'none';
        return;
      }
      progressContainer.style.display = 'flex';
      const percent = Math.min((currentElapsed / currentDuration) * 100, 100);
      progressFill.style.width        = percent + '%';
      timeElapsedEl.textContent       = formatTime(currentElapsed);
      timeDurationEl.textContent      = formatTime(currentDuration);
    });
  }

  // Timer only runs while actually playing
  function startLocalProgress() {
    if (localProgressTimer) return;
    localProgressTimer = setInterval(() => {
      if (currentDuration > 0 && currentElapsed < currentDuration) {
        currentElapsed++;
        updateProgressUI();
      }
    }, 1000);
  }

  function stopLocalProgress() {
    if (localProgressTimer) {
      clearInterval(localProgressTimer);
      localProgressTimer = null;
    }
  }

  // --- 6. PLAYBACK ---
  function togglePlay() {
    if (audio.paused) {
      audio.src = STREAM_URL;
      audio.load();
      audio.play()
        .then(() => {
          isPlaying = true;
          updateUIState(true);
          startMetadataService();
          acquireWakeLock();
          setupMediaSession();
        })
        .catch(() => {
          isPlaying = false;
          updateUIState(false);
        });
    } else {
      audio.pause();
      isPlaying = false;
      updateUIState(false);
      stopMetadataService();
      releaseWakeLock();
    }
  }

  function updateUIState(playing) {
    if (playBtn) {
      playBtn.innerHTML = playing ? '❚❚' : '▶';
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      playBtn.style.paddingLeft = playing ? '0' : '5px';
    }
  }

  // --- 7. VOLUME & MUTE CONTROLS ---
  volumeInput.addEventListener('input', (e) => {
    audio.volume = e.target.value / 100;
    if (volumeDisplay) volumeDisplay.textContent = e.target.value + '%';
    if (audio.volume > 0 && audio.muted) {
      audio.muted = false;
      updateMuteIcon();
      if (audio.paused) audio.play().catch(() => {});
    }
  });

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      const wasMuted = audio.muted;
      audio.muted = !audio.muted;
      updateMuteIcon();
      if (wasMuted && !audio.muted) {
        audio.play().catch(() => {});
      }
    });
  }

  updateMuteIcon();

  // --- 8. METADATA & ALBUM ART ---
  function updateMetadata(title, artist, artUrl) {
    if (
      lastMetadata.title  === title &&
      lastMetadata.artist === artist &&
      lastMetadata.art    === artUrl
    ) return;

    lastMetadata = { title, artist, art: artUrl };

    const t = title  || 'Fetching metadata...';
    const a = artist || (
      'If the wait time is irregular, please try again later ' +
      'and email us at support@qwrt.online'
    );

    songTitleEl.textContent  = t;
    artistNameEl.textContent = a;

    const titleSize  = isMobile ? 1.2 : 2.1;
    const artistSize = isMobile ? 0.9 : 1.45;
    fitText(songTitleEl,  t, titleSize,  0.9);
    fitText(artistNameEl, a, artistSize, 0.75);

    // Show loading state while new art resolves
    albumArtEl.classList.add('loading');

    currentArtImg.onload = () => {
      albumArtEl.classList.remove('loading');
      // Only insert the node if it isn't already a child (first load or after DOM reset)
      if (!albumArtEl.contains(currentArtImg)) {
        albumArtEl.appendChild(currentArtImg);
      }
    };

    currentArtImg.onerror = () => {
      albumArtEl.classList.remove('loading');
    };

    // Trigger new load
    currentArtImg.src = artUrl || DEFAULT_ART;
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator) || !lastMetadata.title) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title:   lastMetadata.title  || 'QWRT Radio',
        artist:  lastMetadata.artist || 'QWRT Radio',
        album:   'QWRT Radio',
        artwork: [{ src: lastMetadata.art || DEFAULT_ART, sizes: '512x512', type: 'image/jpeg' }],
      });
      navigator.mediaSession.playbackState = 'playing';
      navigator.mediaSession.setActionHandler('play',  () => { if (audio.paused) audio.play(); });
      navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); });
      navigator.mediaSession.setActionHandler('stop',  () => {
        audio.pause();
        isPlaying = false;
        updateUIState(false);
      });
    } catch (e) {}
  }

  async function fetchMetadata() {
    try {
      const res = await fetch(`${API_URL}?cb=${Date.now()}`, { mode: 'cors', cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const np   = data.now_playing;

      if (np) {
        currentElapsed  = np.elapsed  || 0;
        currentDuration = np.duration || 0;
        updateProgressUI();
        if (np.song) {
          updateMetadata(np.song.title, np.song.artist, np.song.art);
          setupMediaSession();
        }
      }
    } catch (e) {
      console.warn('Metadata fetch failed:', e);
    }
  }

  function startMetadataService() {
    fetchMetadata();
    if (!metadataInterval) metadataInterval = setInterval(fetchMetadata, 2000);
    startLocalProgress();
  }

  function stopMetadataService() {
    if (metadataInterval) {
      clearInterval(metadataInterval);
      metadataInterval = null;
    }
    stopLocalProgress();   // timer stops with playback, not just metadata
  }

  // --- 9. AUDIO EVENTS ---
  audio.addEventListener('playing', () => {
    updateUIState(true);
    retryCount = 0;
    startLocalProgress();   // resume timer if it was paused
  });

  audio.addEventListener('pause', () => {
    stopLocalProgress();    // halt timer while audio is paused
  });

  audio.addEventListener('error', () => {
    updateUIState(false);
    stopLocalProgress();
    if (retryCount < 5) {
      retryCount++;
      setTimeout(() => { audio.load(); audio.play().catch(() => {}); }, 3000 * retryCount);
    }
  });

  // --- 10. WAKE LOCK ---
  async function acquireWakeLock() {
    if ('wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().then(() => { wakeLock = null; });
    }
  }

  // --- 11. DESKTOP CONTROLS ---
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

  audio.volume = parseInt(volumeInput.value, 10) / 100;

  // --- 12. MOBILE AUTOPLAY (muted) ---
  if (isMobile) {
    audio.src = STREAM_URL;
    audio.load();
    audio.play()
      .then(() => {
        isPlaying = true;
        updateUIState(true);
        startMetadataService();
        acquireWakeLock();
        setupMediaSession();
      })
      .catch((err) => {
        console.warn('Autoplay blocked or unavailable:', err);
      });
  }

  // --- 13. PAGE CONTENT LOADER ---
  fetchMetadata();

  async function loadPages() {
    let contentData = {};
    try {
      const response = await fetch('pages.json?v=' + Date.now());
      if (!response.ok) throw new Error('Failed to load pages.json');
      contentData = await response.json();
    } catch (error) {
      console.error('Error loading pages:', error);
      return;
    }

    const textNav    = document.querySelector('.text-nav');
    const dynHeading = document.getElementById('dyn-heading');
    const dynSub     = document.getElementById('dyn-sub');
    const dynBody    = document.getElementById('dyn-body');
    const pageKeys   = Object.keys(contentData);

    pageKeys.forEach((key, index) => {
      const navItem = document.createElement('a');
      navItem.href      = '#';
      navItem.className = 'nav-item';
      navItem.setAttribute('data-target', key);
      navItem.textContent = key.charAt(0).toLowerCase() + key.slice(1);
      if (index === 0) navItem.classList.add('active');
      textNav.appendChild(navItem);
    });

    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        navItems.forEach((nav) => nav.classList.remove('active'));
        item.classList.add('active');
        const target = item.getAttribute('data-target');
        if (contentData[target]) {
          dynHeading.textContent = contentData[target].heading;
          if (dynSub) dynSub.textContent = contentData[target].sub || '';
          dynBody.textContent = contentData[target].body;
        }
      });
    });

    if (pageKeys.length > 0) {
      const first = pageKeys[0];
      dynHeading.textContent = contentData[first].heading;
      if (dynSub) dynSub.textContent = contentData[first].sub || '';
      dynBody.textContent = contentData[first].body;
    }
  }

  loadPages();

})();