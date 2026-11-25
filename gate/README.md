# Lybi Gate (beta)

The data gate between a bank and Lybi. Every record that moves between them, in either direction, passes one signed field policy:

- **pass**: the value as is
- **hide**: nothing kept
- **token**: a stable HMAC token, plus the value sealed for the bank
- **enc**: sealed for the bank only (RSA-OAEP with the bank's public key)
- **conv**: a reduced value (age, income band, city, scrubbed text), plus the original sealed for the bank

A field the signed policy doesn't know is **hidden**, and added to the draft for the bank to decide.

**A side project.** Its own router (`/api/gate`, one line in `server.js`), services and `gate_*` tables (`db/migrations/074_gate.sql`). It does not read or write agents, crews or the runtime. The only shared code it uses, read-only, is:

- the data-protection detectors (`builder/protection/`);
- the management center's session check (`builder/services/manageSession.js`, `manageAccess.js`).

Client: the management center page (`aspect-react-client/src/manage/pages/GatePage/`).

## Files

| | |
|---|---|
| `routes.js` | the API (every path is listed in its header) |
| `services/policy.js` | versions, draft, learn, sign (ECDSA), verify |
| `services/records.js` | transform through the signed policy, store, model view, dry run |
| `services/connections.js` | the bank's APIs Lybi calls (lookup / handoff). Answers pass the gate |
| `services/keys.js` | inbound keys (`gk_live_…`, shown once, kept as SHA-256) |
| `services/crypto.js` | tokens, sealing, AES-GCM secrets, policy signatures |
| `services/detect.js` | field detection (the #986 detectors, plus field names) and conversions |
| `services/log.js` | traffic and audit log: names, actions, counts, never values |
| `mockBank/` | the stand-in bank: its own key pair (the private key lives only there) and its API |
| `harness.js`, `e2e.js` | local proof without `server.js` |

## Rules

- **No raw sensitive value on the Lybi side.** Only fields the signed policy passes are stored or sent as is. The log never holds a value.
- **Outbound requests follow the stored form.** A token goes out with its sealed value, so the bank resolves it. Hidden fields are not sent.
- **Signing refuses while Lybi-added fields are undecided** (`409 undecided_fields`), unless `acceptNew: true`.

## Secrets

Three secrets live in `.env.production.<env>`: `GATE_TOKEN_KEY`, `GATE_SECRET_KEY` and `GATE_SIGNING_KEY` (base64; the signing key is P-256 PKCS#8 DER). Without them, the API answers `503 gate_not_configured`.

## Run it locally

```bash
node db/migrations/run-074-gate.js --env staging     # once per environment
TZ=UTC node gate/harness.js --env staging --port 3917
node gate/e2e.js                                     # the end-to-end proof
```

The harness boots express with this router only. No platform background service starts. The management-center door is replaced by `harness@local`; the inbound key check stays real.
