(() => {
  const state = {
    osmd: null,
    player: null,
    scoreLoaded: false,
    fallbackTimer: null,
    fallbackSynth: null,
    isFallbackPlaying: false,
    zoom: 1,
    currentSourceLabel: "",
  };

  const statusEl = document.getElementById("status");
  const fileInput = document.getElementById("fileInput");
  const urlInput = document.getElementById("urlInput");
  const loadUrlBtn = document.getElementById("loadUrlBtn");
  const loadSampleBtn = document.getElementById("loadSampleBtn");

  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");

  const playBtn = document.getElementById("playBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const stopBtn = document.getElementById("stopBtn");

  const bpmRange = document.getElementById("bpmRange");
  const bpmValue = document.getElementById("bpmValue");
  const volumeRange = document.getElementById("volumeRange");
  const volumeValue = document.getElementById("volumeValue");

  const setStatus = (message, type = "") => {
    statusEl.textContent = message;
    statusEl.classList.remove("error", "loading");
    if (type) {
      statusEl.classList.add(type);
    }
  };

  const setLoading = (loading, message = "") => {
    const controls = [fileInput, loadUrlBtn, loadSampleBtn, playBtn, pauseBtn, stopBtn];
    controls.forEach((el) => {
      el.disabled = loading || (!state.scoreLoaded && (el === playBtn || el === pauseBtn || el === stopBtn));
    });
    if (loading) {
      setStatus(message || "Loading...", "loading");
    }
  };

  const setPlaybackButtonsEnabled = (enabled) => {
    playBtn.disabled = !enabled;
    pauseBtn.disabled = !enabled;
    stopBtn.disabled = !enabled;
  };

  const stopFallback = () => {
    if (state.fallbackTimer) {
      window.clearInterval(state.fallbackTimer);
      state.fallbackTimer = null;
    }
    state.isFallbackPlaying = false;
  };

  const currentVolume = () => Number(volumeRange.value) / 100;

  const applyPlaybackSettings = () => {
    bpmValue.textContent = bpmRange.value;
    volumeValue.textContent = `${volumeRange.value}%`;

    if (state.player) {
      try {
        if (typeof state.player.setBpm === "function") {
          state.player.setBpm(Number(bpmRange.value));
        }
        if (state.player.playbackSettings) {
          state.player.playbackSettings.masterVolume = currentVolume();
        }
      } catch (error) {
        setStatus("Updated controls, but player settings could not be fully applied.", "error");
      }
    }
  };

  const startFallback = async () => {
    if (!window.Tone) {
      setStatus("Audio player unavailable. Please check CDN access.", "error");
      return;
    }

    await window.Tone.start();

    if (!state.fallbackSynth) {
      state.fallbackSynth = new window.Tone.Synth({
        oscillator: { type: "triangle" },
        envelope: { attack: 0.01, decay: 0.05, sustain: 0.1, release: 0.1 },
      }).toDestination();
    }

    state.fallbackSynth.volume.value = -24 + currentVolume() * 24;

    stopFallback();
    state.osmd.cursor.reset();
    state.osmd.cursor.show();
    state.isFallbackPlaying = true;

    const tickMs = Math.max(60, Math.round(60000 / Number(bpmRange.value)));
    state.fallbackTimer = window.setInterval(() => {
      if (!state.isFallbackPlaying) {
        return;
      }

      state.fallbackSynth.triggerAttackRelease("C5", "16n");

      try {
        state.osmd.cursor.next();
      } catch (_error) {
        stopFallback();
      }
    }, tickMs);
  };

  const initPlayer = async () => {
    stopFallback();

    const PlayerCtor = window.OsmdAudioPlayer;
    state.player = null;

    if (!PlayerCtor) {
      setStatus("osmd-audio-player unavailable, using Tone.js cursor fallback.", "loading");
      return;
    }

    const player = new PlayerCtor();
    await player.loadScore(state.osmd);
    state.player = player;
    applyPlaybackSettings();
  };

  const loadScore = async (source, label) => {
    setLoading(true, `Loading ${label}...`);
    setStatus("", "");

    try {
      stopFallback();
      state.player = null;
      await state.osmd.load(source);
      state.osmd.render();
      state.osmd.cursor.show();
      state.osmd.cursor.reset();
      await initPlayer();
      state.scoreLoaded = true;
      state.currentSourceLabel = label;
      setPlaybackButtonsEnabled(true);
      setLoading(false);
      setStatus(`Loaded ${label} successfully.`);
    } catch (error) {
      state.scoreLoaded = false;
      setPlaybackButtonsEnabled(false);
      setLoading(false);

      let message = "Failed to load score. Please verify the file format or URL.";
      if (String(error && error.message).toLowerCase().includes("cors")) {
        message = "Failed to load URL due to CORS restrictions. Please allow cross-origin access or use local upload.";
      }
      setStatus(message, "error");
    }
  };

  const loadFromUrl = async () => {
    const url = urlInput.value.trim();
    if (!url) {
      setStatus("Please enter a valid MusicXML URL.", "error");
      return;
    }

    setLoading(true, "Fetching URL...");
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const lowerUrl = url.toLowerCase();
      const payload = lowerUrl.endsWith(".mxl") ? await response.arrayBuffer() : await response.text();
      await loadScore(payload, `URL: ${url}`);
    } catch (error) {
      setLoading(false);
      setStatus(
        "Could not fetch URL. Check the link and CORS policy, or download and upload the file locally.",
        "error",
      );
    }
  };

  const loadFromFile = async (file) => {
    if (!file) {
      return;
    }

    const name = file.name.toLowerCase();
    if (!name.endsWith(".xml") && !name.endsWith(".mxl")) {
      setStatus("Unsupported file type. Please choose a .xml or .mxl file.", "error");
      return;
    }

    const payload = name.endsWith(".mxl") ? await file.arrayBuffer() : await file.text();
    await loadScore(payload, `File: ${file.name}`);
  };

  const init = () => {
    const OSMD = window.opensheetmusicdisplay && window.opensheetmusicdisplay.OpenSheetMusicDisplay;
    if (!OSMD) {
      setStatus("OSMD failed to load from CDN.", "error");
      return;
    }

    state.osmd = new OSMD("osmd-container", {
      autoResize: true,
      drawTitle: true,
      drawComposer: true,
      followCursor: true,
      backend: "svg",
    });

    setStatus("Load a file, URL, or sample to start.");

    fileInput.addEventListener("change", (event) => {
      const [file] = event.target.files || [];
      loadFromFile(file);
    });

    loadUrlBtn.addEventListener("click", loadFromUrl);
    loadSampleBtn.addEventListener("click", async () => {
      try {
        setLoading(true, "Loading sample...");
        const res = await fetch("./sample.xml");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const text = await res.text();
        await loadScore(text, "sample.xml");
      } catch (_error) {
        setLoading(false);
        setStatus("Sample failed to load. Please run with a local server instead of file://.", "error");
      }
    });

    zoomInBtn.addEventListener("click", () => {
      if (!state.scoreLoaded) {
        return;
      }
      state.zoom = Math.min(2.5, Number((state.zoom + 0.1).toFixed(2)));
      state.osmd.Zoom = state.zoom;
      state.osmd.render();
    });

    zoomOutBtn.addEventListener("click", () => {
      if (!state.scoreLoaded) {
        return;
      }
      state.zoom = Math.max(0.5, Number((state.zoom - 0.1).toFixed(2)));
      state.osmd.Zoom = state.zoom;
      state.osmd.render();
    });

    playBtn.addEventListener("click", async () => {
      if (!state.scoreLoaded) {
        return;
      }

      try {
        if (state.player) {
          await state.player.play();
        } else {
          await startFallback();
        }
        setStatus(`Playing ${state.currentSourceLabel || "score"}...`);
      } catch (_error) {
        setStatus("Playback failed to start.", "error");
      }
    });

    pauseBtn.addEventListener("click", () => {
      if (state.player && typeof state.player.pause === "function") {
        state.player.pause();
      } else {
        stopFallback();
      }
      setStatus("Paused.");
    });

    stopBtn.addEventListener("click", async () => {
      try {
        if (state.player && typeof state.player.stop === "function") {
          await state.player.stop();
        }
        stopFallback();
        state.osmd.cursor.reset();
        state.osmd.cursor.show();
        setStatus("Stopped.");
      } catch (_error) {
        setStatus("Failed to stop playback cleanly.", "error");
      }
    });

    bpmRange.addEventListener("input", applyPlaybackSettings);
    volumeRange.addEventListener("input", applyPlaybackSettings);
    applyPlaybackSettings();
  };

  document.addEventListener("DOMContentLoaded", init);
})();
