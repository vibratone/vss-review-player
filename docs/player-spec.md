# Player Spec

This file mirrors the Stage 2 player spec from the wider Vibratone planning workspace.

## Repo Decision

The review player will live in a fresh repository:

```text
vss-review-player
```

This avoids changing the existing `ab-player` repository, which is already in use on the Vibratone website.

## Player Link Format

```text
https://vibratone.github.io/vss-review-player/review/?sessionId={{Session ID}}&token={{Submission Token}}
```

## Load Request

```json
{
  "event": "mix_review_config_requested",
  "source": {
    "app": "vibratone-review-player",
    "playerVersion": "v1"
  },
  "reviewSession": {
    "sessionId": "mix_review_session_row_id",
    "submissionToken": "private_session_token"
  }
}
```

## Submit Request

```json
{
  "event": "mix_review_submitted",
  "submittedAt": "2026-05-22T18:30:00Z",
  "source": {
    "app": "vibratone-review-player",
    "playerVersion": "v1"
  },
  "reviewSession": {
    "sessionId": "mix_review_session_row_id",
    "submissionToken": "private_session_token",
    "sessionTitle": "Song Name - Mix Review"
  },
  "client": {
    "clientId": "client_row_id"
  },
  "project": {
    "projectId": "project_row_id"
  },
  "song": {
    "songId": "song_row_id"
  },
  "mix": {
    "mixId": "mix_row_id"
  },
  "comments": [
    {
      "tempCommentId": "client_generated_uuid",
      "selectedVersionId": "mix_version_row_id",
      "selectedVersionLabel": "V2",
      "timestampSeconds": 83.25,
      "timestampLabel": "01:23",
      "text": "Can the lead vocal come up slightly here?",
      "category": "Vocal",
      "status": "Submitted"
    }
  ]
}
```

