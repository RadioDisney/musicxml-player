(() => {
  const state = {
    osmd: null,
    player: null,
    scoreLoaded: false,
    toneScheduled: false,
    zoom: 1,
    currentSourceLabel: "",
    midiOutput: null,
    practiceMode: false,
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

  let midiInitialized = false;

  // Practice mode: set of MIDI note numbers still waiting to be played
  let practiceWaitingNotes = null; // null = not waiting

  const initMidi = async () => {
    if (midiInitialized || !navigator.requestMIDIAccess) return;
    midiInitialized = true;
    try {
      const access = await navigator.requestMIDIAccess({ sysex: true });
      const outputs = Array.from(access.outputs.values());
      const inputs = Array.from(access.inputs.values());
      const sel = document.getElementById("midiOutput");
      if (sel && outputs.length > 0) {
        // 清除已有选项（保留第一个 "-- No MIDI --"）
        while (sel.options.length > 1) sel.remove(1);
        outputs.forEach((out, i) => {
          const opt = document.createElement("option");
          opt.value = i;
          opt.textContent = out.name || `Output ${i}`;
          sel.appendChild(opt);
        });
        sel.addEventListener("change", () => {
          const out = sel.value !== "" ? outputs[Number(sel.value)] : null;
          state.midiOutput = out;
          if (out && out.name && out.name.includes("PartyKeys")) {
            setTimeout(() => {
              try {
                out.send([0xF0, 0x7F, 0x30, 0x7F, 0x7F, 0x20, 0x00, 0x0F, 0x01, 0xF7]);
              } catch (_) {}
            }, 500);
          }
        });
      }

      // Listen on all MIDI inputs for practice mode
      inputs.forEach((input) => {
        input.onmidimessage = (msg) => {
          const [status, note] = msg.data;
          const isNoteOn = (status & 0xf0) === 0x90 && msg.data[2] > 0;
          if (!isNoteOn || !state.practiceMode || !practiceWaitingNotes) return;

          practiceWaitingNotes.delete(note);
          if (practiceWaitingNotes.size === 0) {
            // All required notes played — resume transport
            practiceWaitingNotes = null;
            if (window.Tone && state.toneScheduled) {
              window.Tone.Transport.start();
            }
          }
        };
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
   * Walk the OSMD cursor and collect events using the iterator's own timestamp,
   * so time stays in sync with cursor movement even with complex multi-voice scores.
   */
  const collectEvents = (bpm) => {
    const cursor = state.osmd.cursor;

    // Temporarily disable followCursor to prevent scrolling during event collection
    const wasFollowing = state.osmd.FollowCursor;
    state.osmd.FollowCursor = false;

    cursor.reset();
    cursor.show();

    const events = [];
    const beatDuration = 60000 / bpm; // ms per quarter note
    let cursorStepIndex = 0;

    while (!cursor.Iterator.EndReached) {
      const iter = cursor.Iterator;

      // Use iterator's CurrentSourceTimestamp for accurate timing
      let timeMs;
      if (iter.CurrentSourceTimestamp) {
        timeMs = Number(iter.CurrentSourceTimestamp.RealValue) * 4 * beatDuration;
      } else if (iter.currentTimeStamp) {
        timeMs = Number(iter.currentTimeStamp.RealValue) * 4 * beatDuration;
      } else {
        break;
      }

      const notesUnder = cursor.NotesUnderCursor ? cursor.NotesUnderCursor() : [];
      const pitches = [];

      (notesUnder || []).forEach((note) => {
        if (!note || (typeof note.isRest === "function" && note.isRest())) return;
        const halfTone = getNoteHalfTone(note);
        if (halfTone === null || !Number.isFinite(halfTone)) return;

        const rv = note.Length ? Number(note.Length.RealValue) : 0.25;
        pitches.push({ name: midiToNoteName(halfTone), durationStr: realValueToToneDuration(rv) });
      });

      // Record every cursor step (even rests) so cursor stays in sync
      events.push({ timeMs, pitches, cursorStep: cursorStepIndex });
      cursorStepIndex++;

      cursor.next();
    }

    cursor.reset();
    cursor.show();
    state.osmd.FollowCursor = wasFollowing;
    return events;
  };

  let cursorTimer = null;

  const stopToneFallback = () => {
    if (cursorPart) {
      cursorPart.stop();
      cursorPart.dispose();
      cursorPart = null;
    }
    if (cursorTimer) {
      clearInterval(cursorTimer);
      cursorTimer = null;
    }
    if (window.Tone) {
      window.Tone.Transport.stop();
      window.Tone.Transport.cancel();
    }
    state.toneScheduled = false;
    practiceWaitingNotes = null;
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

    const allEvents = collectEvents(bpm);
    if (allEvents.length === 0) {
      setStatus("No playable notes found in score.", "error");
      return;
    }

    // Reset cursor before playback
    state.osmd.cursor.reset();
    state.osmd.cursor.show();

    // Build audio-only events (merged by time, for scheduling sound)
    const audioEvents = [];
    for (const ev of allEvents) {
      if (ev.pitches.length === 0) continue;
      const last = audioEvents[audioEvents.length - 1];
      if (last && Math.abs(last.timeMs - ev.timeMs) < 1) {
        last.pitches.push(...ev.pitches);
      } else {
        audioEvents.push({ timeMs: ev.timeMs, pitches: [...ev.pitches] });
      }
    }

    // Schedule audio via Tone.Part
    const partEvents = audioEvents.map((ev) => [ev.timeMs / 1000, ev]);

    let prevNoteNames = [];
    const firedTimes = new Set();
    cursorPart = new window.Tone.Part((time, ev) => {
      // Deduplicate: Tone.js lookahead can fire same event twice
      const key = ev.timeMs;
      if (firedTimes.has(key)) return;
      firedTimes.add(key);

      // 先关上一个事件的所有音符
      if (prevNoteNames.length > 0) {
        sendMidiNoteOff(prevNoteNames);
      }

      // 播放当前音符（合成器）— 练习模式下静音
      if (!state.practiceMode) {
        ev.pitches.forEach((p) => {
          polySynth.triggerAttackRelease(p.name, p.durationStr, time);
        });
      }

      // 发送当前 Note On
      const vel = Math.round(currentVolume() * 127);
      const names = ev.pitches.map((p) => p.name);
      sendMidiNoteOn(names, vel);
      prevNoteNames = names;

      // 练习模式：发完 Note On 后暂停，等用户弹对所有音符
      if (state.practiceMode && names.length > 0) {
        const waitMs = Math.max(0, time - window.Tone.context.currentTime) * 1000;
        setTimeout(() => {
          if (!state.toneScheduled) return;
          practiceWaitingNotes = new Set(names.map((n) => noteNameToMidi(n)).filter((n) => n !== null));
          window.Tone.Transport.pause();
          setStatus(`Practice: play ${names.join(", ")}`);
        }, waitMs);
      }
    }, partEvents);

    cursorPart.start(0);

    // Drive cursor independently using a polling timer synced to transport time
    const beatDuration = 60000 / bpm;
    let cursorEventIndex = 0;

    cursorTimer = setInterval(() => {
      if (!state.toneScheduled) return;
      const transportMs = window.Tone.Transport.seconds * 1000;

      // Advance cursor only when the NEXT event's time is reached,
      // so the cursor stays on the current note while it's sounding.
      while (cursorEventIndex < allEvents.length - 1 &&
             allEvents[cursorEventIndex + 1].timeMs <= transportMs) {
        try { state.osmd.cursor.next(); } catch (_) {}
        cursorEventIndex++;
      }
    }, 50); // Poll every 50ms

    // Stop transport at end
    const totalSec = (allEvents[allEvents.length - 1].timeMs / 1000) + 2;
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

    // 用户点击 MIDI 下拉框时才请求权限（远程 HTTPS 站点需要用户手势）
    const midiSel = document.getElementById("midiOutput");
    if (midiSel) midiSel.addEventListener("focus", () => initMidi(), { once: true });

    const practiceToggle = document.getElementById("practiceToggle");
    if (practiceToggle) {
      practiceToggle.addEventListener("change", () => {
        state.practiceMode = practiceToggle.checked;
        // Practice mode needs MIDI input — init if not yet done
        if (state.practiceMode) initMidi();
      });
    }

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
