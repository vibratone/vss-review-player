(function () {
  const config = window.VSS_REVIEW_PLAYER_CONFIG || {};
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("sessionId") || "";
  const submissionToken = params.get("token") || "";
  const useDemo = params.get("demo") === "1";

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  const state = {
    session: null,
    selectedVersionId: "",
    comments: [],
    buffers: new Map(),
    sources: new Map(),
    gains: new Map(),
    audioContext: null,
    duration: 0,
    offset: 0,
    startedAt: 0,
    isReady: false,
    isPlaying: false,
    rafId: null
  };

  const constants = {
    fadeMs: 8,
    endTolerance: 0.03,
    demoDurationSeconds: 32
  };

  const elements = {
    statusBar: document.getElementById("statusBar"),
    reviewLayout: document.getElementById("reviewLayout"),
    sessionTitle: document.getElementById("sessionTitle"),
    clientName: document.getElementById("clientName"),
    projectName: document.getElementById("projectName"),
    songName: document.getElementById("songName"),
    sessionStatus: document.getElementById("sessionStatus"),
    versionTabs: document.getElementById("versionTabs"),
    selectedVersionLabel: document.getElementById("selectedVersionLabel"),
    timeLabel: document.getElementById("timeLabel"),
    playPauseButton: document.getElementById("playPauseButton"),
    seekBar: document.getElementById("seekBar"),
    category: document.getElementById("category"),
    commentText: document.getElementById("commentText"),
    commentTimestamp: document.getElementById("commentTimestamp"),
    captureTimeButton: document.getElementById("captureTimeButton"),
    addCommentButton: document.getElementById("addCommentButton"),
    submitReviewButton: document.getElementById("submitReviewButton"),
    commentsList: document.getElementById("commentsList"),
    commentCount: document.getElementById("commentCount")
  };

  function setStatus(message, tone) {
    elements.statusBar.textContent = message;
    if (tone) {
      elements.statusBar.dataset.tone = tone;
    } else {
      delete elements.statusBar.dataset.tone;
    }
  }

  function formatTime(seconds) {
    const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = Math.floor(safeSeconds % 60);
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }

  function parseTimestamp(value) {
    const cleaned = String(value || "").trim();
    if (!cleaned) return 0;

    const parts = cleaned.split(":").map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) return NaN;

    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return (parts[0] * 60) + parts[1];
    if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
    return NaN;
  }

  function getSelectedVersion() {
    if (!state.session) return null;
    return state.session.versions.find((version) => version.versionId === state.selectedVersionId) || null;
  }

  function getCurrentTime() {
    if (!state.isPlaying || !state.audioContext) return state.offset;
    return Math.min(state.duration, state.offset + (state.audioContext.currentTime - state.startedAt));
  }

  function createPayloadBase(eventName) {
    return {
      event: eventName,
      source: {
        app: "vibratone-review-player",
        playerVersion: "v1-web-audio"
      },
      reviewSession: {
        sessionId,
        submissionToken,
        sessionTitle: state.session.reviewSession.sessionTitle
      },
      client: {
        clientId: state.session.client.clientId
      },
      project: {
        projectId: state.session.project.projectId
      },
      song: {
        songId: state.session.song.songId
      },
      mix: {
        mixId: state.session.mix.mixId
      }
    };
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      return { raw: text };
    }
  }

  async function loadSession() {
    if (useDemo) {
      return getDemoSession();
    }

    if (!sessionId || !submissionToken) {
      throw new Error("This review link is missing its session details.");
    }

    if (!config.configWebhookUrl) {
      throw new Error("The player is not connected to the Make config webhook yet.");
    }

    return postJson(config.configWebhookUrl, {
      event: "mix_review_config_requested",
      source: {
        app: "vibratone-review-player",
        playerVersion: "v1-web-audio"
      },
      reviewSession: {
        sessionId,
        submissionToken
      }
    });
  }

  function validateSession(session) {
    if (!session || typeof session !== "object") {
      throw new Error("The review session response was empty.");
    }
    if (!session.reviewSession) {
      throw new Error("The review session response is missing reviewSession details.");
    }
    if (!Array.isArray(session.versions)) {
      throw new Error("The review session response is missing a versions list.");
    }
    if (!session.versions.length) {
      throw new Error("No mix versions are available for this review link.");
    }
  }

  async function renderSession(session) {
    validateSession(session);
    state.session = session;

    elements.sessionTitle.textContent = session.reviewSession.sessionTitle || "Mix Review";
    elements.clientName.textContent = session.client?.displayName || "Client";
    elements.projectName.textContent = session.project?.name || "Project";
    elements.songName.textContent = session.song?.name || "Song";
    elements.sessionStatus.textContent = session.reviewSession.status || "Open";
    elements.reviewLayout.hidden = false;

    const current = session.versions.find((version) => version.isCurrentVersion) || session.versions[session.versions.length - 1] || session.versions[0];
    state.selectedVersionId = current.versionId;
    renderVersions();
    updateSelectedVersionUI();
    updateTimeUI(0);

    await prepareAudio();
  }

  async function prepareAudio() {
    if (!AudioContextClass) {
      throw new Error("This browser does not support the audio engine needed for synced version switching.");
    }

    setStatus("Loading audio versions…", null);
    elements.playPauseButton.disabled = true;
    state.audioContext = state.audioContext || new AudioContextClass();
    state.buffers.clear();

    for (const version of state.session.versions) {
      const label = version.versionLabel || `V${version.versionNumber || ""}`;
      setStatus(`Loading ${label}…`, null);
      const buffer = await loadVersionBuffer(version);
      state.buffers.set(version.versionId, buffer);
    }

    const durations = Array.from(state.buffers.values()).map((buffer) => buffer.duration).filter(Number.isFinite);
    state.duration = Math.min(...durations);
    state.isReady = true;
    elements.playPauseButton.disabled = false;
    updateTimeUI(0);
    setStatus("Review ready. Press play to begin.", "ok");
  }

  async function loadVersionBuffer(version) {
    if (useDemo && !version.signedAudioUrl) {
      return createDemoBuffer(version);
    }

    if (!version.signedAudioUrl) {
      throw new Error(`${version.versionLabel || "A version"} is missing its signed audio URL.`);
    }

    const response = await fetch(version.signedAudioUrl, { mode: "cors" });
    if (!response.ok) {
      throw new Error(`Could not load ${version.versionLabel || "audio"}. Status ${response.status}.`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return state.audioContext.decodeAudioData(arrayBuffer.slice(0));
  }

  function createDemoBuffer(version) {
    const sampleRate = state.audioContext.sampleRate || 44100;
    const length = sampleRate * constants.demoDurationSeconds;
    const buffer = state.audioContext.createBuffer(2, length, sampleRate);
    const versionNumber = Number(version.versionNumber || 1);
    const baseFrequency = 180 + (versionNumber * 35);

    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) {
        const t = i / sampleRate;
        const kick = Math.sin(2 * Math.PI * 70 * t) * Math.exp(-8 * (t % 1));
        const tone = Math.sin(2 * Math.PI * baseFrequency * t) * 0.17;
        const shimmer = Math.sin(2 * Math.PI * (baseFrequency * 2.01) * t) * 0.06;
        data[i] = (kick * 0.22) + tone + shimmer;
      }
    }

    return Promise.resolve(buffer);
  }

  function renderVersions() {
    elements.versionTabs.innerHTML = "";

    state.session.versions.forEach((version) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = version.versionLabel || `V${version.versionNumber}`;
      button.setAttribute("aria-pressed", String(version.versionId === state.selectedVersionId));
      button.addEventListener("click", () => switchVersion(version.versionId));
      elements.versionTabs.append(button);
    });
  }

  function updateSelectedVersionUI() {
    const version = getSelectedVersion();
    elements.selectedVersionLabel.textContent = version ? (version.versionLabel || `V${version.versionNumber}`) : "Version";
    renderVersions();
  }

  function cleanupSources() {
    state.sources.forEach((source) => {
      try { source.onended = null; } catch (_) {}
      try { source.stop(); } catch (_) {}
      try { source.disconnect(); } catch (_) {}
    });
    state.gains.forEach((gain) => {
      try { gain.disconnect(); } catch (_) {}
    });
    state.sources.clear();
    state.gains.clear();
  }

  function buildSources(offsetSeconds) {
    cleanupSources();

    const safeOffset = Math.max(0, Math.min(offsetSeconds, Math.max(0, state.duration - constants.endTolerance)));
    const when = state.audioContext.currentTime + 0.03;

    state.buffers.forEach((buffer, versionId) => {
      const source = state.audioContext.createBufferSource();
      const gain = state.audioContext.createGain();

      source.buffer = buffer;
      gain.gain.value = versionId === state.selectedVersionId ? 1 : 0;
      source.connect(gain).connect(state.audioContext.destination);
      source.onended = handleEnded;
      source.start(when, safeOffset);

      state.sources.set(versionId, source);
      state.gains.set(versionId, gain);
    });

    state.offset = safeOffset;
    state.startedAt = when;
  }

  async function play() {
    if (!state.isReady) return;
    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }
    if (state.offset >= state.duration - constants.endTolerance) {
      state.offset = 0;
    }
    buildSources(state.offset);
    state.isPlaying = true;
    elements.playPauseButton.classList.add("is-playing");
    elements.playPauseButton.setAttribute("aria-label", "Pause");
    setStatus(`Playing ${elements.selectedVersionLabel.textContent}.`, "ok");
    startAnimation();
  }

  function pause() {
    if (!state.isPlaying) return;
    state.offset = getCurrentTime();
    state.isPlaying = false;
    elements.playPauseButton.classList.remove("is-playing");
    elements.playPauseButton.setAttribute("aria-label", "Play");
    stopAnimation();
    cleanupSources();
    updateTimeUI(state.offset);
    setStatus("Paused.", null);
  }

  function handleEnded() {
    const current = getCurrentTime();
    if (current < state.duration - constants.endTolerance) return;
    state.isPlaying = false;
    state.offset = 0;
    elements.playPauseButton.classList.remove("is-playing");
    elements.playPauseButton.setAttribute("aria-label", "Play");
    stopAnimation();
    cleanupSources();
    updateTimeUI(0);
    setStatus("Playback finished.", "ok");
  }

  function switchVersion(versionId) {
    if (versionId === state.selectedVersionId) return;
    state.selectedVersionId = versionId;
    updateSelectedVersionUI();

    if (!state.isPlaying) {
      setStatus(`${elements.selectedVersionLabel.textContent} selected.`, "ok");
      return;
    }

    const now = state.audioContext.currentTime;
    const end = now + (constants.fadeMs / 1000);

    state.gains.forEach((gain, gainVersionId) => {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(gainVersionId === versionId ? 1 : 0, end);
    });

    setStatus(`Playing ${elements.selectedVersionLabel.textContent}.`, "ok");
  }

  function seekTo(seconds) {
    const safeSeconds = Math.max(0, Math.min(seconds, state.duration || 0));
    state.offset = safeSeconds;

    if (state.isPlaying) {
      buildSources(safeSeconds);
    }

    updateTimeUI(safeSeconds);
  }

  function updateTimeUI(currentSeconds) {
    const current = Math.max(0, Math.min(currentSeconds, state.duration || 0));
    elements.timeLabel.textContent = `${formatTime(current)} / ${formatTime(state.duration || 0)}`;
    elements.commentTimestamp.value = formatTime(current);

    const progress = state.duration ? Math.min(100, (current / state.duration) * 100) : 0;
    elements.seekBar.value = String(Math.round((current / Math.max(state.duration || 0.001, 0.001)) * 1000));
    elements.seekBar.style.setProperty("--progress", `${progress}%`);
  }

  function startAnimation() {
    stopAnimation();
    const tick = () => {
      const current = getCurrentTime();
      updateTimeUI(current);
      if (state.isPlaying) {
        state.rafId = requestAnimationFrame(tick);
      }
    };
    state.rafId = requestAnimationFrame(tick);
  }

  function stopAnimation() {
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
  }

  function addComment() {
    const text = elements.commentText.value.trim();
    const selectedVersion = getSelectedVersion();
    const timestampSeconds = parseTimestamp(elements.commentTimestamp.value);

    if (!selectedVersion) {
      setStatus("Choose a mix version before adding a note.", "error");
      return;
    }
    if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0 || timestampSeconds > Math.max(state.duration, 0)) {
      setStatus("Use a valid timestamp before adding the note.", "error");
      return;
    }
    if (!text) {
      setStatus("Add a comment before saving the note.", "error");
      return;
    }

    state.comments.push({
      tempCommentId: makeId(),
      selectedVersionId: selectedVersion.versionId,
      selectedVersionLabel: selectedVersion.versionLabel || `V${selectedVersion.versionNumber}`,
      timestampSeconds: Number(timestampSeconds.toFixed(3)),
      timestampLabel: formatTime(timestampSeconds),
      text,
      category: elements.category.value,
      status: "Submitted"
    });

    elements.commentText.value = "";
    renderComments();
    setStatus("Timestamped note added.", "ok");
  }

  function renderComments() {
    elements.commentsList.innerHTML = "";
    elements.commentCount.textContent = `${state.comments.length} ${state.comments.length === 1 ? "note" : "notes"}`;

    if (!state.comments.length) {
      const empty = document.createElement("div");
      empty.className = "empty-comments";
      empty.textContent = "No notes yet. Add a note while listening to capture the exact timestamp and version.";
      elements.commentsList.append(empty);
      return;
    }

    state.comments.forEach((comment, index) => {
      const item = document.createElement("article");
      item.className = "comment-item";
      item.innerHTML = `
        <strong>${comment.timestampLabel}</strong>
        <span class="comment-version">${escapeHtml(comment.selectedVersionLabel)}</span>
        <span class="comment-category">${escapeHtml(comment.category)}</span>
        <p>${escapeHtml(comment.text)}</p>
      `;
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "comment-delete";
      deleteButton.textContent = "Remove";
      deleteButton.addEventListener("click", () => {
        state.comments.splice(index, 1);
        renderComments();
        setStatus("Note removed.", null);
      });
      item.append(deleteButton);
      elements.commentsList.append(item);
    });
  }

  async function submitReview() {
    if (!state.session) {
      setStatus("The review session has not loaded yet.", "error");
      return;
    }
    if (!state.comments.length) {
      setStatus("Add at least one note before submitting the review.", "error");
      return;
    }
    if (!config.submitWebhookUrl && !useDemo) {
      setStatus("The review submit webhook is not connected yet.", "error");
      return;
    }

    const payload = {
      ...createPayloadBase("mix_review_submitted"),
      submittedAt: new Date().toISOString(),
      comments: state.comments
    };

    try {
      elements.submitReviewButton.disabled = true;
      setStatus("Submitting review…", null);

      if (!useDemo) {
        await postJson(config.submitWebhookUrl, payload);
      } else if (config.enableConsolePayloadLogs !== false) {
        console.info("Demo submit payload", payload);
      }

      setStatus("Review submitted. Thank you.", "ok");
    } catch (error) {
      console.error(error);
      elements.submitReviewButton.disabled = false;
      setStatus("The review could not be submitted. Please try again.", "error");
    }
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `comment_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#039;"
      };
      return entities[char];
    });
  }

  function getDemoSession() {
    return {
      reviewSession: {
        sessionId: "demo_session",
        sessionTitle: "Demo Song - Mix Review",
        status: "Open",
        expiresAt: "2026-06-01T18:00:00Z"
      },
      client: {
        clientId: "demo_client",
        displayName: "Demo Client"
      },
      project: {
        projectId: "demo_project",
        name: "Demo Project"
      },
      song: {
        songId: "demo_song",
        name: "Demo Song"
      },
      mix: {
        mixId: "demo_mix"
      },
      versions: [
        {
          versionId: "demo_v1",
          versionNumber: 1,
          versionLabel: "V1",
          signedAudioUrl: "",
          durationSeconds: constants.demoDurationSeconds,
          isCurrentVersion: false
        },
        {
          versionId: "demo_v2",
          versionNumber: 2,
          versionLabel: "V2",
          signedAudioUrl: "",
          durationSeconds: constants.demoDurationSeconds,
          isCurrentVersion: false
        },
        {
          versionId: "demo_v3",
          versionNumber: 3,
          versionLabel: "V3",
          signedAudioUrl: "",
          durationSeconds: constants.demoDurationSeconds,
          isCurrentVersion: true
        }
      ]
    };
  }

  elements.playPauseButton.addEventListener("click", async () => {
    try {
      if (state.isPlaying) {
        pause();
      } else {
        await play();
      }
    } catch (error) {
      console.error(error);
      setStatus("Playback could not start. Please try again.", "error");
    }
  });

  elements.seekBar.addEventListener("input", () => {
    if (!state.duration) return;
    const seconds = (Number(elements.seekBar.value) / 1000) * state.duration;
    updateTimeUI(seconds);
  });

  elements.seekBar.addEventListener("change", () => {
    if (!state.duration) return;
    const seconds = (Number(elements.seekBar.value) / 1000) * state.duration;
    seekTo(seconds);
  });

  elements.captureTimeButton.addEventListener("click", () => {
    updateTimeUI(getCurrentTime());
    setStatus("Current timestamp captured.", "ok");
  });

  elements.addCommentButton.addEventListener("click", addComment);
  elements.submitReviewButton.addEventListener("click", submitReview);

  renderComments();

  loadSession()
    .then(renderSession)
    .catch((error) => {
      console.error(error);
      elements.reviewLayout.hidden = true;
      setStatus(error.message || "The review session could not be loaded.", "error");
    });
})();
