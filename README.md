# Podcast Script Agent

This Coral agent listens for mentions and turns fetched article content into a concise podcast script.  
It ignores duplicate requests in the same thread unless the message includes `force_regenerate` (or `"force": true`) to bypass the guard.

## Configuration

Set the following Coral options:

- `OPENAI_API_KEY` – API key with access to the desired OpenAI model.
- `OPENAI_MODEL` – Optional override for the model (defaults to the deployment default).
- `SCRIPT_PROMPT_APPEND` – Optional extra instruction appended to the system prompt.
- `PODCAST_HOST_VOICE_ID` – Optional override for the host voice ID (defaults to `gmnazjXOFoOcWA59sd5m`).
- `PODCAST_GUEST_VOICE_ID` – Optional override for the guest voice ID (defaults to `1kNciG1jHVSuFBPoxdRZ`).

## Scripts

```bash
npm install
npm run dev
```

Run `npm run dev` during development so code changes hot-reload thanks to `tsx`. Coral Server executes the same command via `coral-agent.toml`.
