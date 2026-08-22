# FROSTMIND — LLM Orchestration Plan (Ollama, zero new hardware)

Cross-references `FROSTMIND_Prototype_to_Production_Plan.md` (most of Phase A/B there is now done) and `FROSTMIND_MVP_Implementation_and_AI_Plan (1).md` (the Model 1/2/3 boundary this plan builds on top of, not around).

**Status: implemented.** See `backend/app/llm_orchestrator.py` and its module docstring for the authoritative current state — this doc is the design it implements, not a living status page. `backend/README.md`'s LLM section has the "what's actually verified" writeup.

---

## 1. What the LLM does, and what it explicitly doesn't

Models 1–3 stay exactly what they are: Model 3 computing real shelf-life numbers, Model 1's offline checkpoints proving the anomaly-detection approach, Model 2 waiting on INA219. **The LLM doesn't replace any of them and shouldn't try** — it's a bad tool for precise numerical time-series reasoning, and you already have the right tool for that.

What it's actually good for: **synthesizing structured outputs into a decision and an explanation.** Given an alert, Model 3's shelf-life number, the shipment's category, and recent history, an LLM can produce "here's what this means and what to do about it" in a way a threshold rule can't — and generate the compliance narrative the original architecture always called for. This is the Supervisor and Compliance agent concepts from the phase 2 doc, finally getting a real implementation.

---

## 2. Architecture — one integration, two roles

**One new module**, matching the existing pattern: `app/llm_orchestrator.py`, sitting next to `app/ml.py`.

**Role A — alert reasoning (triggered automatically).** When `/ingest`'s existing rate-limited alert logic creates an Alert row, enqueue an orchestration call. It gathers: the alert itself, Model 3's current shelf-life output, the shipment's category and recent SensorReadings, and recent alert history for that shipment. Sends this to Ollama, gets back a structured recommendation, stores it on the Alert row.

**Role B — compliance report generation (triggered on demand).** Same Ollama integration, different prompt: a "generate report" action in the shipment detail view assembles the full shipment history and produces a formatted incident narrative. This is genuinely the Compliance agent from the original architecture, built with the same integration standing up Role A — no separate system needed.

---

## 3. Model choice

Run Ollama locally (`ollama serve`, default `localhost:11434`) — same machine as the FastAPI backend, no new hardware. **As implemented:** reused a model already pulled on the dev machine rather than downloading a fresh one — `hf.co/unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL` (Gemma-4, ~7.5B params, QAT — quantization-aware training — Q4_K_XL). QAT quantization is arguably a better fit than a generic post-training Q4_K_M for reliable structured JSON output, since it's specifically trained to preserve quality at that bit-width rather than quantized after the fact. Config is overridable via `FROSTMIND_OLLAMA_MODEL` if you want to swap to `qwen2.5:7b`/`llama3.1:8b`/etc. later — nothing else changes.

**Quantization:** Q4_K_M (or better, QAT) is the sweet spot for this — good quality/speed balance. Avoid very aggressive low-bit quantization (like IQ3) if reliable structured JSON matters, since low-bit quantization measurably hurts a model's ability to follow strict output formats — this ruled out a couple of already-downloaded models on the dev machine specifically (an IQ3_M variant, and an "uncensored/aggressive" fine-tune inappropriate for a safety-adjacent application regardless of its quant).

---

## 4. Wiring into the existing backend

Implemented in `app/llm_orchestrator.py` (`_call_ollama`, `assess_alert`, `generate_compliance_report`) — uses `httpx.AsyncClient`, `format: "json"` for Role A, `stream: false` throughout.

**Trigger point:** `app/routers/ingest.py`, where Alert rows already get created — enqueued as a FastAPI `BackgroundTask` (`run_alert_reasoning_background`) rather than awaited inline. Local LLM inference adds real seconds of latency; the ESP32 waiting on `/ingest`'s response is never blocked on it.

**Storage:** `llm_assessment`, `llm_recommended_action`, `llm_narrative` columns on the Alert model. Surfaced in the admin panel's existing alert feed and detail view.

**Timeout, measured not guessed:** a cold Ollama call (model not already loaded in memory) measured at ~25s on the dev machine (17s model load + 8s inference) before writing any integration code, per §8 step 1 below. That left almost no margin against a 30s timeout, so the actual configured default is 45s (`FROSTMIND_OLLAMA_TIMEOUT_SECONDS`) — a background task has no user waiting on it, so there's no real cost to the extra margin, only a cost to spurious fallbacks on every first call after Ollama idles the model out.

---

## 5. The one hard boundary: the LLM never touches actuation

**The IR/HVAC trigger stays on the deterministic path** — the ESP32's threshold rule now, Model 1 once it's live. The LLM's output feeds the *explanation and recommendation* surfaced to a human in the admin panel; it does not fire the physical command. LLM output is inherently less predictable than a validated threshold or a trained classifier, so it shouldn't be the thing that controls a real actuator. This also protects against an embarrassing demo failure if the model produces something odd — worst case, a recommendation looks strange in the UI; it never causes the wrong physical action.

---

## 6. Reliability

- **JSON parse fallback.** Local models occasionally don't perfectly follow the schema even with `format: "json"`. If parsing fails, log the raw response and fall back to showing the deterministic alert data without the LLM narrative — never let a malformed LLM response break the alert pipeline.
- **Timeout.** 45s (see §4); if exceeded, same fallback as above.
- **Background, always.** Never blocks `/ingest`'s response path.
- Every failure path (unreachable, timeout, malformed JSON, missing keys) returns `None` uniformly and logs a structured event — see `app/llm_orchestrator.py`'s module docstring for the exact contract callers rely on.

---

## 7. Testing

`backend/tests/test_llm_orchestrator.py` mocks the Ollama HTTP call throughout — no running local model required to run the suite. Explicitly tests the parse-fallback path (a local model returning prose instead of JSON), not just the easier-to-imagine timeout/unreachable paths, since that's the most likely real failure mode in practice. Also two end-to-end tests through the real `/ingest` and `/compliance_report` endpoints confirming the pipeline survives an LLM failure and correctly populates the new fields on success.

**Real gotcha found and fixed while adding this:** without a default mock, every *other* test file's alert-creating `/ingest` calls also fired a real background call against whatever Ollama happens to be running locally — slow (added ~65s to the suite) and exactly what this section says not to depend on. Fixed with an autouse fixture in `conftest.py` that mocks Ollama to fail fast by default everywhere; `test_llm_orchestrator.py`'s own mocks correctly override that default for the tests that care about LLM behavior specifically.

---

## 8. Build order

1. ~~Stand up Ollama, pull the model, sanity-check it manually with `curl` against a hand-written prompt before writing any integration code.~~ Done — Ollama was already running with a suitable model pulled; verified with a real alert scenario before writing `llm_orchestrator.py`.
2. ~~Build `llm_orchestrator.py` as a standalone script first~~ — built directly as the real module since the manual curl check already validated output quality/schema-following.
3. ~~Wire it into `/ingest` as a background task.~~ Done.
4. ~~Surface the output in the admin panel's existing alert views.~~ Done — see `web/`.
5. ~~Add the compliance-report generation as the second use of the same integration (Role B).~~ Done — `POST /shipments/{id}/compliance_report`.
6. ~~Add the tests from §7.~~ Done, including the autouse-mock fix above.
