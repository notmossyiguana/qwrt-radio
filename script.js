(function () {
  // script held together with duct tape fahhh //
  const audio         = document.getElementById('radio-stream');
  const playBtn       = document.getElementById('play-btn');
  const volumeInput   = document.getElementById('volume');
  const volumeDisplay = document.getElementById('volume-display');
  const songTitleEl   = document.getElementById('song-title');
  const artistNameEl  = document.getElementById('artist-name');
  const albumArtEl    = document.getElementById('album-art');
  
  const progressContainer = document.getElementById('progress-container');
  const progressFill      = document.getElementById('progress-fill');
  const timeElapsedEl     = document.getElementById('time-elapsed');
  const timeDurationEl    = document.getElementById('time-duration');

  const STREAM_URL = "https://stream.qwrt.online/listen/qwrt_radio/radio.mp3";
  const API_URL    = "https://stream.qwrt.online/api/nowplaying/qwrt_radio";

  let isPlaying = false, retryCount = 0, metadataInterval = null, wakeLock = null;
  let lastMetadata = { title:'', artist:'', art:'' };
  let currentElapsed = 0, currentDuration = 0, localProgressTimer = null;

  const DEFAULT_ART = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="%23f0f0f0"/><text x="50%" y="50%" font-family="Arial" font-size="200" fill="%23cccccc" text-anchor="middle" dy=".3em">♪</text></svg>';

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  function updateProgressUI() {
    if (currentDuration <= 0) {
      progressContainer.style.display = 'none';
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
    playBtn.innerHTML = playing ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playBtn.style.paddingLeft = playing ? '0' : '5px';
  }

  volumeInput.addEventListener('input', (e) => {
    audio.volume = e.target.value / 100;
    volumeDisplay.textContent = e.target.value + '%';
  });

  function updateMetadata(title, artist, artUrl) {
    if (lastMetadata.title === title && lastMetadata.artist === artist && lastMetadata.art === artUrl) return;
    lastMetadata = { title, artist, art: artUrl };

    const t = title  || 'QWRT Radio';
    const a = artist || 'Broadcasting Live';

    songTitleEl.textContent  = t;
    artistNameEl.textContent = a;
    fitText(songTitleEl,  t, 2.1, 0.9);
    fitText(artistNameEl, a, 1.45, 0.75);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = artUrl || DEFAULT_ART;
    img.onload = () => {
      albumArtEl.innerHTML = '';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.className = 'loaded';
      albumArtEl.appendChild(img);
    };
    img.onerror = () => { albumArtEl.innerHTML = '<span style="font-size:5rem;opacity:0.3;position:absolute;">♪</span>'; };
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator) || !lastMetadata.title) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: lastMetadata.title || 'QWRT Radio',
        artist: lastMetadata.artist || 'Broadcasting Live',
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

  playBtn.addEventListener('click', togglePlay);
  
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') { 
        e.preventDefault(); 
        togglePlay(); 
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchMetadata();
  });

  audio.volume = parseInt(volumeInput.value) / 100;
  fetchMetadata();
  startLocalProgress();
  
  // pages
  const contentData = {
    home: {
      heading: "Welcome to QWRT",
      sub: "Independent music, broadcasting 24/7.",
      body: "This is the placeholder body text. Select a link from the navigation menu above to dynamically change this content without reloading the page. You can easily edit these text sections inside the script tag at the bottom of the HTML file."
    },
    about: {
      heading: "About the Station",
      sub: "Our story and mission.",
      body: "QWRT Radio is dedicated to giving a platform to independent artists, DJs, and creators. We broadcast globally, ad-free, relying entirely on the support of our listeners and community."
    },
    schedule: {
      heading: "Live Shows & DJs",
      sub: "Check out our weekly lineup.",
      body: "From electronic beats on Friday nights to ambient Sunday mornings, our curated roster of resident DJs brings you the best underground sounds from around the world."
    }
  };

  const navItems = document.querySelectorAll('.nav-item');
  const dynHeading = document.getElementById('dyn-heading');
  const dynSub = document.getElementById('dyn-sub');
  const dynBody = document.getElementById('dyn-body');


  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      
      navItems.forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');

      const target = item.getAttribute('data-target');
      if (contentData[target]) {
        dynHeading.textContent = contentData[target].heading;
        dynSub.textContent     = contentData[target].sub;
        dynBody.textContent    = contentData[target].body;
      }
    });
  });

})();
