# Podcast Generator Agent

This agent listens for mentions in Coral threads and turns provided dialogue JSON into a podcast-ready MP3 using ElevenLabs text-to-dialogue.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `CORAL_CONNECTION_URL` | ✅ | Coral SSE endpoint used to receive mentions |
| `ELEVENLABS_API_KEY` | ✅ | ElevenLabs API key for TTS synthesis |
| `CORAL_AGENT_ID` | | Agent identifier used when filtering mentions (default `podcast_generator`) |
| `ELEVENLABS_OUTPUT_FORMAT` | | ElevenLabs output format, e.g. `mp3_44100_128` |
| `ELEVENLABS_RETURN_BASE64` | | Set to `1`/`true` to include base64 audio in responses |
| `MAX_INLINE_BYTES` | | Max bytes allowed for inline base64 payload (default `5242880`) |
| `OUTPUT_DIR` | | Directory for generated audio files (default `out`) |
| `WAIT_TIMEOUT_MS` | | Timeout for mention polling in milliseconds (default `600000`) |

## Scripts

- `npm run dev` – start the agent with `tsx` watcher
- `npm run build` – compile TypeScript to `dist`
- `npm run start` – run the built agent

The agent expects the mentioned message to include either `{ "dialogue": [...] }` or `{ "inputs": [...] }` JSON payloads containing `text` and `voice_id` pairs. Inputs must already be valid JSON—the agent validates structure but does not attempt automatic repair.
