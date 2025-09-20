# Coral Agents Article Podcast

## Setup

Clone this repository:

```sh
git clone git@github.com:junwatu/coral-agents.git agents
cd agents
```

Build the agents on each folder agent:

```sh
npm install
npm build
```

## Register agents to Coral Server

To add these agents to the coral server, edit the `registry.toml` and add this configuration:

```toml
[[local-agent]]
path = "../agents/article-fetcher"

[[local-agent]]
path = "../agents/podcast-script"

[[local-agent]]
path = "../agents/podcast-generator"

```

Please adjust the path relative to the coral server directory.
