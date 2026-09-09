# Lead Collector SDK release bundle

All JavaScript files in this directory are generated from
`app/lead_collector/static/lead-collector.js`. Do not edit a release copy by
hand:

```powershell
python scripts/build_lead_collector_sdk.py
```

SDK version: `1.4.2`.

```text
lead-collector-sdk/
  lead-collector.js
  v1.4.2/lead-collector.js
  latest/lead-collector.js
  README.md
```

Publish this directory alone to a small public repository. A production site
should use an immutable URL, for example:

```text
https://cdn.jsdelivr.net/gh/GITHUB_USER/lead-collector-sdk@v1.4.2/lead-collector.js
```

## Install

```html
<script defer
  src="STABLE_SDK_URL"
  data-project-id="PROJECT_ID"
  data-endpoint="COLLECTOR_API_URL"
  data-public-key="PROJECT_PUBLIC_KEY"
  data-auto="true">
</script>
```

The SDK contains no server token, OAuth credential, bot token, project key,
endpoint hostname, or personal data. `data-public-key` and `data-endpoint` are
site-specific browser configuration.

AutoCapture records a form attempt on submit, then delivers a lead only after
a correlated success signal. For an uncommon host form whose success cannot
be detected safely, add this one line to its existing confirmed callback:

```js
LeadCollector.success(form);
```

For native form redirects/reloads, version 1.4.2 retains a five-minute,
session-scoped pending snapshot containing only safe semantic fields and page
context. It recovers that same source lead ID only after an explicit success
URL marker or a known success UI marker; normal reloads, failure URLs, direct
success-page visits, and already delivered attempts do not send a lead.

`LeadCollector.send(payload)` remains available for existing explicit SDK
1.0.x integrations. See `docs/LEAD_COLLECTOR.md` in the source project for
security rules, adapters, and remote-rules design.
