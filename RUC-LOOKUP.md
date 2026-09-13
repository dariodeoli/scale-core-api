# RUC lookup provider configuration

The API calls an HTTPS provider only from `POST /api/agency/ruc-lookup` or the explicit client refresh route. The provider never runs in demo organizations.

## Environment

- `RUC_LOOKUP_PROVIDER_URL` — HTTPS endpoint prefix. The API appends `/{normalized-ruc}`. Defaults to `https://ruc.sun.com.py/api/ruc` for backwards compatibility; set this explicitly in each deployment.
- `RUC_LOOKUP_TIMEOUT_MS` — provider timeout, 1,000–30,000 ms; default `12000`.
- `RUC_LOOKUP_CACHE_TTL_SECONDS` — successful lookup cache TTL, 60–604,800 seconds; default `86400`.
- `RUC_LOOKUP_NO_RESULT_TTL_SECONDS` — not-found cache TTL, 60–86,400 seconds; default `3600`.
- `RUC_LOOKUP_MONTHLY_LIMIT` — external calls per month, 1–100; default `100`.

The provider must return HTTP `404` when there is no record, or JSON with `name`, `ruc`, `dv`, optional `fullRuc`, `state`, and `publicationDateText` for a record. All other provider failures become a safe `503` response; provider response bodies and URLs are never exposed.

## API

- `POST /api/agency/ruc-lookup` body `{ "ruc": "80.168.807 - 8" }` returns a normalized record, `{record:null}` for a safe no-result, and `cached`.
- `POST /api/agency/clients/:id/ruc-refresh` reads the client’s existing complete RUC. Without `apply:true` it previews the fresh provider record. With `{ "apply": true }` it only stores provider metadata (`ruc_legal_name`, `ruc_tax_state`, source and refresh timestamp); it never changes the user-managed client name, legal name, contact data, or notes.
- `POST /api/agency/clients/from-ruc` remains the explicit create confirmation route.
