(() => {
  const state = {
    osmd: null,
    player: null,
    scoreLoaded: false,
    toneScheduled: false,
    zoom: 1,
    currentSourceLabel: "",
    midiOutput: null,
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
    if (type) statusEl.classList.add(type);
  };

  const setLoading = (loading, message = "") => {
    [fileInput, loadUrlBtn, loadSampleBtn, playBtn, pauseBtn, stopBtn].forEach((el) => {
      el.disabled = loading || (!state.scoreLoaded && [playBtn, pauseBtn, stopBtn].includes(el));
    });
    if (loading) setStatus(message || "Loading...", "loading");
  };

  const setPlaybackButtonsEnabled = (enabled) => {
    playBtn.disabled = !enabled;
    pauseBtn.disabled = !enabled;
    stopBtn.disabled = !enabled;
  };

  const currentVolume = () => Number(volumeRange.value) / 100;

  const applyPlaybackSettings = () => {
    bpmValue.textContent = bpmRange.value;
    volumeValue.textContent = `${volumeRange.value}%`;
    if (state.player) {
      try {
        if (typeof state.player.setBpm === "function") state.player.setBpm(Number(bpmRange.value));
        if (state.player.playbackSettings) state.player.playbackSettings.masterVolume = currentVolume();
      } catch (e) {
        setStatus(`Failed to apply settings: ${e?.message || "unknown"}`, "error");
      }
    }
  };

  // ─── Web MIDI ─────────────────────────────────────────────────────────────────

  const noteNameToMidi = (name) => {
    const m = name.match(/^([A-G]#?)(-?\d+)$/);
    if (!m) return null;
    const map = { C:0,"C#":1,D:2,"D#":3,E:4,F:5,"F#":6,G:7,"G#":8,A:9,"A#":10,B:11 };
    const s = map[m[1]];
    return s !== undefined ? (Number(m[2]) + 1) * 12 + s : null;
  };

  const sendMidiNoteOn = (pitches, velocity) => {
    if (!state.midiOutput) return;
    pitches.forEach((name) => {
      const n = noteNameToMidi(name);
      if (n !== null && n >= 0 && n <= 127) state.midiOutput.send([0x90, n, velocity]);
    });
  };

  const sendMidiNoteOff = (pitches) => {
    if (!state.midiOutput) return;
    pitches.forEach((name) => {
      const n = noteNameToMidi(name);
      if (n !== null && n >= 0 && n <= 127) state.midiOutput.send([0x80, n, 0]);
    });
  };

  const sendMidiAllNotesOff = () => {
    if (state.midiOutput) state.midiOutput.send([0xb0, 123, 0]);
  };

  const initMidi = async () => {
    if (!navigator.requestMIDIAccess) return;
    try {
      const access = await navigator.requestMIDIAccess();
      const outputs = Array.from(access.outputs.values());
      const sel = document.getElementById("midiOutput");
      if (!sel || outputs.length === 0) return;
      outputs.forEach((out, i) => {
        const opt = document.createElement("option");
        opt.value = i;
        opt.textContent = out.name || `Output ${i}`;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", () => {
        state.midiOutput = sel.value !== "" ? outputs[Number(sel.value)] : null;
      });
    } catch (_) {}
  };

  // ─── Tone.js fallback ────────────────────────────────────────────────────────

  let polySynth = null;
  let cursorPart = null;

  /**
   * Read the MIDI half-tone from an OSMD Note regardless of version.
   * OSMD exposes pitch as note.pitch (lowercase) in some builds and as a
   * top-level note.halfTone getter in others.
   */
  const getNoteHalfTone = (note) => {
    // Try the most common paths in order
    if (typeof note.halfTone === "number") return note.halfTone;
    if (note.pitch && typeof note.pitch.halfTone === "number") return note.pitch.halfTone;
    if (note.Pitch && typeof note.Pitch.halfTone === "number") return note.Pitch.halfTone;
    return null;
  };

  /** Convert a MIDI note number (where C4 = 60) to a Tone.js note name. */
  const midiToNoteName = (midi) => {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const octave = Math.floor(midi / 12) - 1;
    return `${names[midi % 12]}${octave}`;
  };

  /** Map a note's RealValue fraction to the nearest Tone.js duration string. */
  const realValueToToneDuration = (rv) => {
    if (!Number.isFinite(rv) || rv <= 0) return "8n";
    const table = [[1, "1n"], [0.75, "2n."], [0.5, "2n"], [0.375, "4n."], [0.25, "4n"],
                   [0.1875, "8n."], [0.125, "8n"], [0.09375, "16n."], [0.0625, "16n"]];
    return table.reduce((best, cur) =>
      Math.abs(cur[0] - rv) < Math.abs(best[0] - rv) ? cur : best
    )[1];
  };

  /**
   * Walk the OSMD cursor from the beginning and collect every event as:
   *   { timeMs, notes: ["C4", "E4", …], durationStr: "4n" }
   * This is done synchronously before playback so Tone.js can schedule everything.
   */
  const collectEvents = (bpm) => {
    const cursor = state.osmd.cursor;
    cursor.reset();
    cursor.show();

    const events = [];
    let timeMs = 0;

    while (!cursor.Iterator.EndReached) {
      const notesUnder = cursor.NotesUnderCursor ? cursor.NotesUnderCursor() : [];
      const pitches = [];
      let longestRv = 0;
      let durationStr = "4n";

      (notesUnder || []).forEach((note) => {
        if (!note || (typeof note.isRest === "function" && note.isRest())) return;
        const halfTone = getNoteHalfTone(note);
        if (halfTone === null || !Number.isFinite(halfTone)) return;
        pitches.push(midiToNoteName(halfTone));

        const rv = note.Length ? Number(note.Length.RealValue) : 0.25;
        if (rv > longestRv) {
          longestRv = rv;
          durationStr = realValueToToneDuration(rv);
        }
      });

      if (pitches.length > 0) {
        events.push({ timeMs, pitches, durationStr });
      }

      // Advance time by the beat duration (quarter note at given BPM)
      const beatDuration = 60000 / bpm;           // ms per quarter note
      const stepRv = longestRv > 0 ? longestRv : 0.25;
      timeMs += stepRv * 4 * beatDuration;        // whole-note duration × fraction

      cursor.next();
    }

    cursor.reset();
    cursor.show();
    return events;
  };

  const stopToneFallback = () => {
    if (cursorPart) {
      cursorPart.stop();
      cursorPart.dispose();
      cursorPart = null;
    }
    if (window.Tone) {
      window.Tone.Transport.stop();
      window.Tone.Transport.cancel();
    }
    state.toneScheduled = false;
    sendMidiAllNotesOff();
  };

  const startToneFallback = async () => {
    if (!window.Tone) {
      setStatus("Tone.js fallback unavailable. Check CDN access.", "error");
      return;
    }

    await window.Tone.start();
    stopToneFallback();

    // (Re)create polyphonic synth
    if (polySynth) { polySynth.dispose(); polySynth = null; }
    polySynth = new window.Tone.PolySynth(window.Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.02, decay: 0.1, sustain: 0.3, release: 0.5 },
    }).toDestination();
    polySynth.volume.value = -24 + currentVolume() * 24;

    const bpm = Number(bpmRange.value) || 120;
    window.Tone.Transport.bpm.value = bpm;

    const events = collectEvents(bpm);
    if (events.length === 0) {
      setStatus("No playable notes found in score.", "error");
      return;
    }

    // Schedule cursor movement in sync
    const cursorEvents = events.map((ev) => [ev.timeMs / 1000, ev]);

    cursorPart = new window.Tone.Part((time, ev) => {
      // Schedule audio
      polySynth.triggerAttackRelease(ev.pitches, ev.durationStr, time);

      // Send MIDI
      const vel = Math.round(currentVolume() * 127);
      sendMidiNoteOn(ev.pitches, vel);
      const durMs = window.Tone.Time(ev.durationStr).toMilliseconds();
      setTimeout(() => sendMidiNoteOff(ev.pitches), durMs);

      // Advance visual cursor (must run in draw callback for DOM)
      window.Tone.getDraw().schedule(() => {
        try { state.osmd.cursor.next(); } catch (_) {}
      }, time);
    }, cursorEvents);

    cursorPart.start(0);

    // Stop transport at end
    const totalSec = (events[events.length - 1].timeMs / 1000) + 1;
    window.Tone.Transport.schedule(() => {
      stopToneFallback();
      state.osmd.cursor.reset();
      state.osmd.cursor.show();
      setStatus(`Finished playing ${state.currentSourceLabel || "score"}.`);
    }, totalSec);

    window.Tone.Transport.start();
    state.toneScheduled = true;
  };

  // ─── OSMD Audio Player (primary) ─────────────────────────────────────────────

  const initPlayer = async () => {
    stopToneFallback();
    state.player = null;

    const PlayerCtor = window.OsmdAudioPlayer;
    if (!PlayerCtor) {
      setStatus("osmd-audio-player unavailable — using Tone.js fallback.", "");
      return;
    }
    try {
      const player = new PlayerCtor();
      await player.loadScore(state.osmd);
      state.player = player;
      applyPlaybackSettings();
    } catch (e) {
      state.player = null;
      setStatus(`Audio player init failed (${e?.message || "unknown"}) — using Tone.js fallback.`, "");
    }
  };

  // ─── Score loading ────────────────────────────────────────────────���───────────

  const loadScore = async (source, label) => {
    setLoading(true, `Loading ${label}...`);
    try {
      stopToneFallback();
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
      let msg = "Failed to load score. Please verify the file format or URL.";
      const txt = String(error?.message || "").toLowerCase();
      if (label.startsWith("URL:") && (txt.includes("cors") || txt.includes("failed to fetch") || error?.name === "TypeError")) {
        msg = "Failed to load URL due to CORS restrictions. Please use local upload instead.";
      }
      setStatus(msg, "error");
    }
  };

  const loadFromUrl = async () => {
    const url = urlInput.value.trim();
    if (!url) { setStatus("Please enter a valid MusicXML URL.", "error"); return; }
    setLoading(true, "Fetching URL...");
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = url.toLowerCase().endsWith(".mxl") ? await response.arrayBuffer() : await response.text();
      await loadScore(payload, `URL: ${url}`);
    } catch (error) {
      setLoading(false);
      setStatus(`Could not fetch URL. Check the link and CORS policy.${error?.message ? ` (${error.message})` : ""}`, "error");
    }
  };

  const loadFromFile = async (file) => {
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!name.endsWith(".xml") && !name.endsWith(".mxl")) {
      setStatus("Unsupported file type. Please choose a .xml or .mxl file.", "error");
      return;
    }
    const payload = name.endsWith(".mxl") ? await file.arrayBuffer() : await file.text();
    await loadScore(payload, `File: ${file.name}`);
  };

  // ─── Init ─────────────────────────────────────────────────────────────────────

  const init = () => {
    const OSMD = window.opensheetmusicdisplay && window.opensheetmusicdisplay.OpenSheetMusicDisplay;
    if (!OSMD) { setStatus("OSMD failed to load from CDN.", "error"); return; }

    state.osmd = new OSMD("osmd-container", {
      autoResize: true,
      drawTitle: true,
      drawComposer: true,
      followCursor: true,
      backend: "svg",
    });

    setStatus("Load a file, URL, or sample to start.");

    initMidi();

    fileInput.addEventListener("change", (e) => { const [f] = e.target.files || []; loadFromFile(f); });
    loadUrlBtn.addEventListener("click", loadFromUrl);

    loadSampleBtn.addEventListener("click", async () => {
      try {
        setLoading(true, "Loading sample...");
        const res = await fetch("./sample.xml");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadScore(await res.text(), "sample.xml");
      } catch (_) {
        setLoading(false);
        setStatus("Sample failed to load. Please use a web server or GitHub Pages.", "error");
      }
    });

    zoomInBtn.addEventListener("click", () => {
      if (!state.scoreLoaded) return;
      state.zoom = Math.min(2.5, Number((state.zoom + 0.1).toFixed(2)));
      state.osmd.Zoom = state.zoom; state.osmd.render();
    });
    zoomOutBtn.addEventListener("click", () => {
      if (!state.scoreLoaded) return;
      state.zoom = Math.max(0.5, Number((state.zoom - 0.1).toFixed(2)));
      state.osmd.Zoom = state.zoom; state.osmd.render();
    });

    playBtn.addEventListener("click", async () => {
      if (!state.scoreLoaded) return;
      try {
        if (state.player) {
          await state.player.play();
        } else {
          await startToneFallback();
        }
        setStatus(`Playing ${state.currentSourceLabel || "score"}...`);
      } catch (_) {
        setStatus("Playback failed to start.", "error");
      }
    });

    pauseBtn.addEventListener("click", () => {
      if (state.player && typeof state.player.pause === "function") {
        state.player.pause();
      } else if (window.Tone) {
        window.Tone.Transport.pause();
      }
      setStatus("Paused.");
    });

    stopBtn.addEventListener("click", async () => {
      try {
        if (state.player && typeof state.player.stop === "function") await state.player.stop();
        stopToneFallback();
        state.osmd.cursor.reset();
        state.osmd.cursor.show();
        setStatus("Stopped.");
      } catch (_) {
        setStatus("Failed to stop playback cleanly.", "error");
      }
    });

    bpmRange.addEventListener("input", applyPlaybackSettings);
    volumeRange.addEventListener("input", applyPlaybackSettings);
    applyPlaybackSettings();
  };

  document.addEventListener("DOMContentLoaded", init);
})();
