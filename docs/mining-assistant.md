# Mining evidence assistant

The public Cockpit can ask Foundry to interpret the current public D01 run's
validated latest readings, five-minute summary and event-ID reconciliation.
The backend, not the visitor or model, selects the durable admitted run and
queries its fixed bounded Fabric functions. Every answer includes the exact
source snapshot, sample/refresh times and quality for inspection. Interpretations
can be wrong; missing data is not health and correlation is not cause.

This is **not a native Fabric Data Agent integration**. It does not invoke the
athlete agent, execute model-selected tools/KQL, operate equipment or accept a
visitor-selected endpoint, identity, run or query. Native Data Agent creation,
private execution and any supported service-principal bridge remain separate
acceptance work.

## Enable and operate

Deploy both application images through the existing immutable-image Actions.
On the backend, explicitly set `MINING_PUBLIC_DEMO_ASSISTANT_ENABLED=true`.
The existing public demo/read and ingestion reconciliation flags must also be
true. The already-configured Foundry project endpoint/model and backend managed
identity are reused; no new API key, browser consent, public Foundry endpoint
or agent-definition write is needed. A configured endpoint is not proof of
model access: verify an actual answer after deployment.

Use the Cockpit's **Ask / inspect evidence** form in LIVE mode after starting
a public demo run. `POST /api/mining/demo/assistant` accepts only
`{"plantId":"D01","question":"..."}` with at most 1000 characters. Same-origin
JSON is required. The legacy delegated `/api/mining/assistant` remains disabled.
Changing scope/time mode clears the answer and aborts its pending browser request.

The BFF supplies only its server credential. The backend independently verifies
that service caller and the durable public-run marker. It rereads run authority
after generation and discards a result if the run changed. The model receives
only that bounded public snapshot and question, with no tools or conversation
history; Responses storage is disabled. Provider-side service logging/retention
is governed by the selected Azure service. Do not enter secrets or personal data.

Limits per running process: six admitted questions per minute, one backend
generation at a time, 64 KiB source evidence, 1200 model output tokens and no
automatic SDK retries. The existing HTTP deadlines also apply. These are
replica-local demo limits, not a distributed spending cap; review quotas and
deployment scale before increasing replicas or offering production access.
Disabled configuration, missing authority/source, model failure, timeout and
rate limits return explicit failures, not canned successful answers.

Disable by removing the opt-in flag or setting it to `false`. No resources or
stored conversation need deletion.
