# Lead Collector SDK release bundle

This directory is a publish-ready bundle for the universal browser SDK. The
JavaScript files are generated from
`app/lead_collector/static/lead-collector.js`; do not edit either release copy
by hand. Rebuild them with:

```powershell
python scripts/build_lead_collector_sdk.py
```

For a separate public repository, copy only this bundle's generated files:

```text
lead-collector-sdk/
  lead-collector.js                 # generated current version
  v1.0.1/lead-collector.js          # immutable release
  latest/lead-collector.js          # optional convenience alias
  README.md
```

The simplest public distribution is a GitHub repository with jsDelivr:

```text
https://cdn.jsdelivr.net/gh/GITHUB_USER/lead-collector-sdk@v1.0.1/lead-collector.js
```

GitHub Pages is also supported:

```text
https://GITHUB_USER.github.io/lead-collector-sdk/v1.0.1/lead-collector.js
```

Use the versioned URL in production. Publishing is a manual GitHub action;
this project does not push or publish anything automatically.

## Universal installation

```html
<script
  src="STABLE_SDK_URL"
  data-project-id="PROJECT_ID"
  data-endpoint="COLLECTOR_API_URL"
  data-public-key="PROJECT_PUBLIC_KEY">
</script>
```

The SDK contains no server token, OAuth credential, bot token, project public
key, domain, or personal data. `data-public-key` is browser-public project
configuration. `data-endpoint` is the Lead Collector API origin.

For the current temporary smoke endpoint only:

```html
<script
  src="STABLE_SDK_URL"
  data-project-id="spilexpert"
  data-endpoint="https://eloquent-foster-unbounded.ngrok-free.dev"
  data-public-key="PROJECT_PUBLIC_KEY">
</script>
```

The ngrok Free hostname is an API endpoint example, not an SDK hosting URL,
and must not be treated as a production hostname.

## API

Call `LeadCollector.send({...})` only after the host form has confirmed
success. The SDK does not intercept forms, `fetch`, or XHR. It fills page URL,
referrer, UTM values, timestamp, and Metrika ClientId when available; absent
ClientId does not block delivery. `LeadCollector.version` is `1.0.1`.
