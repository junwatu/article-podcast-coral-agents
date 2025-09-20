# Coral Agents Article Podcast

To add these agents to the coral server, edit the `registry.toml` and add this configuration:

```
[[local-agent]]
path = "../agents/article-fetcher"

[[local-agent]]
path = "../agents/podcast-script"

[[local-agent]]
path = "../agents/podcast-generator"

```

Please adjust the path relative to the coral server directory.
