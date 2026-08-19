# HQ connectors

One file per data source. The sync engine (`hq/services/sync.service.js`) knows
nothing about Notion or Drive — it calls this interface and stores whatever
comes back.

```js
{
  id:       'notion',              // stable key: URL segment, hq_sources.kind
  name:     'Notion',              // shown in the UI
  isConfigured(): boolean,         // credentials present?

  // Inventory. `since` is the watermark — return only things edited after it
  // when the source can sort by edit time, and set `reachedEnd: false` so the
  // caller knows a deletion could have been missed.
  async list({ since }, onProgress): {
    items: [{ externalId, title, url, parentTitle, objectType, editedAt }],
    reachedEnd: boolean,
  },

  // Content for one item, as markdown.
  async fetch(item): { title, body, url, externalId, people, tags, occurredAt },
}
```

Everything else — runs, cancellation, watermarks, faceted filters, the whole
Integrations screen — is source-agnostic and comes for free.

**Rule:** a connector reaches only what it is credentialled for. Scope belongs
in the credential (a service account that is a member of one Drive), never in a
filter here — a filter is a rule someone forgets.
