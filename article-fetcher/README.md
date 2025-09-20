# Article Fetcher

The Article Fetcher Agent listens for mentions on a Coral MCP connection, extracts the first URL from each message, and responds with cleaned article metadata and content. It is designed to run inside the Coral server environment but can be used anywhere that provides the Coral tools API.

## Register on Coral Server

Add this line in the `registry.toml`:

```toml
[[local-agent]]
path = "../agents/article-fetcher"
```

Please not the path is relative to the coral server root.