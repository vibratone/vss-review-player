(function () {
  const config = window.VSS_REVIEW_PLAYER_CONFIG || {};
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("sessionId") || "";
  const submissionToken = params.get("token") || "";
  const useDemo = params.get("demo") === "1";

  const state = {
    session: null,
    selectedVersionId: "",
    comments: []
  };

  const elements = {
    statusBar: document.getElementById("statusBar"),
    reviewLayout: document.getElementById("reviewLayout"),
    sessionTitle: document.getElementById("sessionTitle"),
    clientName: document.getElementById("clientName"),
    songName: document.getElementById("songName"),
    sessionStatus: document.getElementById("sessionStatus"),
    versionTabs: document.getElementById("versionTabs"),
    selectedVersionLabel: document.getElementById("selectedVersionLabel"),
    audioPlayer: document.getElementById("audioPlayer"),
    timeLabel: document.getElementById("timeLabel"),
    category: document.getElementById("category"),
    commentText: document.getElementById("commentText"),
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

  function getSelectedVersion() {
    return state.session.versions.find((version) => version.versionId === state.selectedVersionId);
  }

  function createPayloadBase(eventName) {
    return {
      event: eventName,
      source: {
        app: "vibratone-review-player",
        playerVersion: "v1"
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

    return response.json();
  }

  async function loadSession() {
    if (useDemo) {
      return getDemoSession();
    }

    if (!sessionId || !submissionToken) {
      throw new Error("This review link is missing its session details.");
    }

    if (!config.configWebhookUrl) {
      throw new Error("The player is not connected to Make yet.");
    }

    return postJson(config.configWebhookUrl, {
      event: "mix_review_config_requested",
      source: {
        app: "vibratone-review-player",
        playerVersion: "v1"
      },
      reviewSession: {
        sessionId,
        submissionToken
      }
    });
  }

  function renderSession(session) {
    state.session = session;

    elements.sessionTitle.textContent = session.reviewSession.sessionTitle;
    elements.clientName.textContent = session.client.displayName || "Client";
    elements.songName.textContent = session.song.name || "Song";
    elements.sessionStatus.textContent = session.reviewSession.status || "Open";
    elements.reviewLayout.hidden = false;

    if (!session.versions.length) {
      setStatus("No mix versions are available for this review link.", "error");
      return;
    }

    const current = session.versions.find((version) => version.isCurrentVersion) || session.versions[0];
    selectVersion(current.versionId, 0);
    setStatus("Review session ready.", "ok");
  }

  function renderVersions() {
    elements.versionTabs.innerHTML = "";

    state.session.versions.forEach((version) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = version.versionLabel || `V${version.versionNumber}`;
      button.setAttribute("aria-pressed", String(version.versionId === state.selectedVersionId));
      button.addEventListener("click", () => {
        selectVersion(version.versionId, elements.audioPlayer.currentTime);
      });
      elements.versionTabs.append(button);
    });
  }

  function selectVersion(versionId, keepTime) {
    state.selectedVersionId = versionId;
    const version = getSelectedVersion();

    elements.selectedVersionLabel.textContent = version.versionLabel || `V${version.versionNumber}`;
    elements.audioPlayer.src = version.signedAudioUrl || "";
    elements.audioPlayer.currentTime = keepTime || 0;
    elements.timeLabel.textContent = formatTime(keepTime || 0);
    renderVersions();
  }

  function addComment() {
    const text = elements.commentText.value.trim();
    const selectedVersion = getSelectedVersion();

    if (!text) {
      setStatus("Add a comment before saving the note.", "error");
      return;
    }

    const timestampSeconds = elements.audioPlayer.currentTime || 0;

    state.comments.push({
      tempCommentId: crypto.randomUUID(),
      selectedVersionId: selectedVersion.versionId,
      selectedVersionLabel: selectedVersion.versionLabel,
      timestampSeconds,
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
      empty.className = "comment-item";
      empty.innerHTML = "<p>No notes yet.</p>";
      elements.commentsList.append(empty);
      return;
    }

    state.comments.forEach((comment) => {
      const item = document.createElement("article");
      item.className = "comment-item";
      item.innerHTML = `
        <strong>${comment.timestampLabel}</strong>
        <span>${comment.selectedVersionLabel} / ${comment.category}</span>
        <p>${escapeHtml(comment.text)}</p>
      `;
      elements.commentsList.append(item);
    });
  }

  async function submitReview() {
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
      setStatus("Submitting review...", null);

      if (!useDemo) {
        await postJson(config.submitWebhookUrl, payload);
      } else {
        console.info("Demo submit payload", payload);
      }

      setStatus("Review submitted. Thank you.", "ok");
    } catch (error) {
      elements.submitReviewButton.disabled = false;
      setStatus("The review could not be submitted. Please try again.", "error");
    }
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => {
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
          durationSeconds: 214.32,
          isCurrentVersion: false
        },
        {
          versionId: "demo_v2",
          versionNumber: 2,
          versionLabel: "V2",
          signedAudioUrl: "",
          durationSeconds: 214.32,
          isCurrentVersion: true
        },
        {
          versionId: "demo_v3",
          versionNumber: 3,
          versionLabel: "V3",
          signedAudioUrl: "",
          durationSeconds: 214.32,
          isCurrentVersion: false
        }
      ]
    };
  }

  elements.audioPlayer.addEventListener("timeupdate", () => {
    elements.timeLabel.textContent = formatTime(elements.audioPlayer.currentTime);
  });

  elements.addCommentButton.addEventListener("click", addComment);
  elements.submitReviewButton.addEventListener("click", submitReview);
  renderComments();

  loadSession()
    .then(renderSession)
    .catch((error) => {
      setStatus(error.message, "error");
    });
})();

