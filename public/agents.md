# Timebox Agent Integration Guide

This document describes how an AI agent can read and process Timebox capture data
stored in Google Drive. Timebox is a voice-first activity capture PWA that syncs
entries to the user's Drive account.

## Overview

Timebox captures timestamped activity entries (voice memos, notes, photos) and
stores them as an append-only log of events in Google Drive. The user's chat
assistant (you) can read this data to:

- Answer questions about the user's activities
- Process entries into calendar events (timelog skill)
- Analyze patterns over time
- Search by location, time, or content

## Prerequisites

Before you can access Timebox data:

1. **User has sync enabled**: The user must have connected Google Drive in Timebox settings
2. **You have Drive access**: You need Google Drive read access to the user's account
3. **Folder exists**: Look for `timebox/` in the user's Drive root

## Onboarding Checklist

Run through these steps to verify your setup:

### 1. Check Drive Access

```bash
# Using gcloud CLI (authenticate first with: gcloud auth login)
gcloud auth application-default print-access-token
```

### 2. Find the Timebox Folder

```bash
# Search for the timebox folder
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://www.googleapis.com/drive/v3/files?q=name='timebox'+and+mimeType='application/vnd.google-apps.folder'+and+'root'+in+parents&fields=files(id,name)" \
  | jq '.files[0]'
```

### 3. List Streams

```bash
# Replace FOLDER_ID with the timebox folder ID from step 2
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://www.googleapis.com/drive/v3/files?q='FOLDER_ID'+in+parents&fields=files(id,name,mimeType)" \
  | jq '.files'
```

## Drive Folder Structure

```
timebox/                              # Root folder (created by app)
  streams.json                        # Registry of active streams
  timelog/                            # One folder per stream
    config.json                       # Stream settings (target calendar, user notes)
    log/                              # IMMUTABLE append-only event log
      2026-08-02/                     # Date partition (local date of loggedAt)
        000041_2026-08-02T09-04-11-0400_a1b2c3.json   # Event record
        000041_2026-08-02T09-04-11-0400_a1b2c3.m4a    # Audio attachment
        000042_2026-08-02T12-31-05-0400_d4e5f6.json
        000042_2026-08-02T12-31-05-0400_d4e5f6.m4a
        000042_2026-08-02T12-31-05-0400_d4e5f6_note.txt
    checkpoint.json                   # Consumer cursor (your last processed seq)
    results/                          # Processing reports (skill writes here)
      2026-08-02.json
```

**Filename format**: `{seq6}_{timestamp}_{id}.json`
- `seq6`: 6-digit zero-padded sequence number
- `timestamp`: ISO timestamp with colons replaced by dashes
- `id`: Short unique event identifier

Sorting filenames lexicographically gives you log order.

## Event Schema (capture.event.v1)

All events follow the NDJSON format with schema `capture.event.v1`. There are three event types:

### capture — Creates an Entry

```json
{
  "schema": "capture.event.v1",
  "type": "capture",
  "id": "a1b2c3",
  "seq": 41,
  "stream": "timelog",
  "loggedAt": "2026-08-02T09:04:11-04:00",
  "capturedAt": "2026-08-02T09:04:11-04:00",
  "deviceTz": "America/New_York",
  "location": {
    "lat": 40.7128,
    "lng": -74.006,
    "accuracyM": 25,
    "placeLabel": "Office",
    "address": "123 Main St, New York"
  },
  "attachments": [
    {
      "kind": "audio",
      "file": "000041_2026-08-02T09-04-11-0400_a1b2c3.m4a",
      "mimeType": "audio/mp4",
      "durationSec": 3.2
    }
  ]
}
```

### amend — Patches a Prior Entry

```json
{
  "schema": "capture.event.v1",
  "type": "amend",
  "id": "b2c3d4",
  "seq": 43,
  "stream": "timelog",
  "loggedAt": "2026-08-02T09:10:00-04:00",
  "deviceTz": "America/New_York",
  "targets": ["a1b2c3"],
  "patch": {
    "capturedAt": "2026-08-02T09:00:00-04:00"
  },
  "attachments": [
    {
      "kind": "text",
      "file": "000043_2026-08-02T09-10-00-0400_b2c3d4_note.txt",
      "mimeType": "text/plain"
    }
  ]
}
```

### revoke — Hides an Entry

```json
{
  "schema": "capture.event.v1",
  "type": "revoke",
  "id": "c3d4e5",
  "seq": 44,
  "stream": "timelog",
  "loggedAt": "2026-08-02T09:15:00-04:00",
  "deviceTz": "America/New_York",
  "targets": ["a1b2c3"]
}
```

## The Fold Algorithm

To get the current visible entries, fold all events in sequence order:

1. **Sort events** by `(seq, loggedAt, id)` — filenames already sort this way
2. **Process capture events**: Each creates a new entry
3. **Apply amend events**: Merge patches into target entries, add new attachments
4. **Apply revoke events**: Mark target entries as hidden

```python
def fold(events):
    entries = {}  # id -> entry
    for event in sorted(events, key=lambda e: (e['seq'], e['loggedAt'], e['id'])):
        if event['type'] == 'capture':
            entries[event['id']] = {
                'id': event['id'],
                'seq': event['seq'],
                'capturedAt': event['capturedAt'],
                'location': event.get('location'),
                'attachments': event['attachments'],
                'revoked': False
            }
        elif event['type'] == 'amend':
            for target_id in event['targets']:
                if target_id in entries:
                    entry = entries[target_id]
                    if patch := event.get('patch'):
                        if 'capturedAt' in patch:
                            entry['capturedAt'] = patch['capturedAt']
                        if 'location' in patch:
                            entry['location'] = patch['location']
                        elif patch.get('clearLocation'):
                            entry['location'] = None
                    if attachments := event.get('attachments'):
                        entry['attachments'].extend(attachments)
        elif event['type'] == 'revoke':
            for target_id in event['targets']:
                if target_id in entries:
                    entries[target_id]['revoked'] = True
    return [e for e in entries.values() if not e['revoked']]
```

## Example: Reading Today's Captures

Here's a complete bash script to read today's capture entries:

```bash
#!/bin/bash
set -euo pipefail

# Get access token
TOKEN=$(gcloud auth print-access-token)
STREAM="timelog"
TODAY=$(date +%Y-%m-%d)

# 1. Find timebox folder
TIMEBOX_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/drive/v3/files?q=name='timebox'+and+mimeType='application/vnd.google-apps.folder'+and+'root'+in+parents&fields=files(id)" \
  | jq -r '.files[0].id')

if [ "$TIMEBOX_ID" = "null" ]; then
  echo "Error: timebox folder not found"
  exit 1
fi

# 2. Find stream folder
STREAM_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/drive/v3/files?q=name='$STREAM'+and+'$TIMEBOX_ID'+in+parents&fields=files(id)" \
  | jq -r '.files[0].id')

# 3. Find log folder
LOG_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/drive/v3/files?q=name='log'+and+'$STREAM_ID'+in+parents&fields=files(id)" \
  | jq -r '.files[0].id')

# 4. Find today's partition
PARTITION_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/drive/v3/files?q=name='$TODAY'+and+'$LOG_ID'+in+parents&fields=files(id)" \
  | jq -r '.files[0].id')

if [ "$PARTITION_ID" = "null" ]; then
  echo "No entries for $TODAY"
  exit 0
fi

# 5. List and download event records (*.json files)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/drive/v3/files?q='$PARTITION_ID'+in+parents+and+name+contains+'.json'&orderBy=name&fields=files(id,name)" \
  | jq -r '.files[] | "\(.id) \(.name)"' \
  | while read -r FILE_ID FILE_NAME; do
      echo "=== $FILE_NAME ==="
      curl -s -H "Authorization: Bearer $TOKEN" \
        "https://www.googleapis.com/drive/v3/files/$FILE_ID?alt=media"
      echo
    done
```

## Common Query Patterns

### List entries for a date range

```bash
# Get all partitions, filter by date range
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/drive/v3/files?q='$LOG_ID'+in+parents&fields=files(id,name)" \
  | jq -r '.files[] | select(.name >= "2026-08-01" and .name <= "2026-08-07") | .id'
```

### Find entries by location

After downloading events, filter in your processing:
```python
entries = [e for e in fold(events)
           if e.get('location', {}).get('placeLabel') == 'Office']
```

### Get unprocessed entries (for skills)

Read `checkpoint.json` to find your last processed sequence:
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/drive/v3/files/$CHECKPOINT_ID?alt=media" \
  | jq '.consumedThroughSeq'
```

Then select events with `seq > consumedThroughSeq`.

### Download audio attachments

```bash
# Get the audio file referenced in an event's attachments
AUDIO_FILE="000041_2026-08-02T09-04-11-0400_a1b2c3.m4a"
FILE_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/drive/v3/files?q=name='$AUDIO_FILE'+and+'$PARTITION_ID'+in+parents&fields=files(id)" \
  | jq -r '.files[0].id')

curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/drive/v3/files/$FILE_ID?alt=media" \
  -o audio.m4a
```

## Writing Results (Skills Only)

If you're implementing a processing skill, update `results/<date>.json`:

```json
{
  "schema": "capture.results.v1",
  "stream": "timelog",
  "date": "2026-08-02",
  "processedAt": "2026-08-02T21:03:00-04:00",
  "entries": [
    {
      "id": "a1b2c3",
      "outcome": "ok",
      "displayTitle": "Work",
      "displayDetail": "9:04 AM – 12:30 PM",
      "transcript": "arrived at work"
    }
  ],
  "warnings": []
}
```

Then update `checkpoint.json` with the highest seq you processed:

```json
{
  "schema": "capture.checkpoint.v1",
  "stream": "timelog",
  "consumedThroughSeq": 44,
  "updatedAt": "2026-08-02T21:03:00-04:00",
  "consumer": "your-skill-name"
}
```

**Important**: Always update the checkpoint *last* — if you crash before updating
it, the next run will safely reprocess the same events.

## Key Invariants

1. **Append-only**: The `log/` tree is immutable. Never edit or delete files.
2. **Atomic writes**: The `.json` record is the commit — attachments upload first.
3. **Idempotent processing**: Use event IDs for deduplication; re-running is safe.
4. **Deterministic fold**: Same events always produce same visible entries.

## Need Help?

- Full spec: See `SPEC.md` in the Timebox repository
- Architecture: See `docs/ARCHITECTURE.md`
- Source: https://github.com/elimelt/timebox
