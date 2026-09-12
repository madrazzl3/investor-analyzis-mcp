# Agent definitions, workflow wiring, and saved artifacts

Status: target v1 design with a local fake-only subset implemented. See [config usage](../../config/README.md) for the current format and runtime limitations. This defines our own configuration format, not an MCP standard or a Convex API.

## Core decision

Keep three things separate:

1. Agent definition: behavior, named input/output contracts, prompt, model profile, allowed tools, and execution limits.
2. Workflow definition: named instances of agents and explicit bindings from submitted inputs or upstream outputs.
3. Runtime records: immutable configuration snapshot, actual inputs, attempts, validated artifacts, and lineage in Convex.

Use JSON for configuration, Markdown for prompts, and JSON Schema for artifact/input contracts. Resolve references from a trusted, versioned repository registry. Never execute JavaScript, shell commands, template expressions, or arbitrary URLs from a configuration file.

## Proposed files

```text
config/
  agents/
    extract-claims.v1.json
    check-consistency.v1.json
    verify-findings.v1.json
    write-report.v1.json
  workflows/
    diligence.v1.json
  models/
    grok-primary.v1.json
  prompts/
    extract-claims.v1.md
    check-consistency.v1.md
    verify-findings.v1.md
    write-report.v1.md
  schemas/
    source-documents.v1.json
    claims.v1.json
    findings.v1.json
    verified-findings.v1.json
    report.v1.json
```

The examples below describe the target Grok configuration. The runnable local bundle uses `models/local-fake.v1.json` and empty tool lists; production Grok profiles/tools are not accepted yet. Schema IDs resolve to local JSON Schema documents. Start with exact matching schema IDs at connections rather than attempting general schema-subtyping inference. The existing Zod configuration validators and Convex database validators remain boundary checks; authored artifact contracts have one canonical JSON Schema source, not separately maintained conflicting definitions.

## Agent definition

Example `check-consistency.v1.json`:

```json
{
  "formatVersion": 1,
  "id": "check-consistency",
  "version": "1.0.0",
  "description": "Compare statements and identify candidate discrepancies.",
  "promptFile": "prompts/check-consistency.v1.md",
  "modelProfile": "grok-primary@1.0.0",
  "inputs": {
    "documents": {
      "schema": "source-documents@1.0.0",
      "delivery": "attachments"
    },
    "claims": {
      "schema": "claims@1.0.0",
      "delivery": "json"
    }
  },
  "outputs": {
    "findings": { "schema": "findings@1.0.0" }
  },
  "tools": ["evidence.read", "math.calculate"],
  "limits": {
    "maxModelCalls": 6,
    "maxInputTokens": 60000,
    "maxOutputTokensPerCall": 6000,
    "timeoutSeconds": 180
  },
  "retry": {
    "maxAttempts": 2,
    "on": ["rate_limit", "provider_unavailable"]
  }
}
```

Limits are illustrative starting values, not validated model limits or promised spend. The effective limit is the strictest of agent configuration, deployment policy, organization policy, and remaining workflow budget. Define `maxAttempts` as total attempts including the first; the model-call limit applies across attempts. Retry delay/backoff is a runtime policy. Invalid schema output is recorded as a failed attempt and is not automatically retried in v1.

`delivery: attachments` accepts authorized document-version references, never arbitrary provider file IDs supplied by an end user. The adapter resolves them to xAI uploads and attaches them to the request. `delivery: json` sends the validated payload under its input-port name. Source text and upstream outputs are labeled as untrusted data, separate from developer-controlled instructions.

Every declared input is required in v1. A supported empty input is an explicit schema-valid value (for example, an empty findings array), never an absent or failed upstream result. Every declared output must be produced. The model returns an object keyed by output name, which the runtime validates and saves as named artifacts in one logical commit.

Tool IDs refer to implemented, versioned tools in the runtime registry. Declaring a tool requests a capability; it does not grant additional case permissions. Provider-managed attachment search must also be recorded and budgeted where observable. Files attached to Grok may trigger internal search, so request token limits alone do not bound total file-search cost.

The model profile resolves to the xAI provider, a concrete configured model identifier, and supported settings. Do not place API keys in config. Resolve and snapshot the actual model identifier before execution; do not silently change profiles or fall back to another model mid-run.

## Workflow definition

Example `diligence.v1.json`:

```json
{
  "formatVersion": 1,
  "id": "diligence",
  "version": "1.0.0",
  "inputs": {
    "documents": { "schema": "source-documents@1.0.0" }
  },
  "limits": {
    "maxParallelSteps": 3,
    "maxModelCalls": 24
  },
  "steps": {
    "extract": {
      "agent": "extract-claims@1.0.0",
      "inputs": {
        "documents": { "from": "input", "name": "documents" }
      }
    },
    "consistency": {
      "agent": "check-consistency@1.0.0",
      "inputs": {
        "documents": { "from": "input", "name": "documents" },
        "claims": { "from": "step", "step": "extract", "output": "claims" }
      }
    },
    "verify": {
      "agent": "verify-findings@1.0.0",
      "inputs": {
        "documents": { "from": "input", "name": "documents" },
        "findings": {
          "from": "step",
          "step": "consistency",
          "output": "findings"
        }
      }
    },
    "report": {
      "agent": "write-report@1.0.0",
      "inputs": {
        "verifiedFindings": {
          "from": "step",
          "step": "verify",
          "output": "verifiedFindings"
        }
      }
    }
  },
  "outputs": {
    "report": { "from": "step", "step": "report", "output": "report" }
  }
}
```

The agent registry must define exactly these ports: extract takes documents and returns claims; consistency takes documents/claims and returns findings; verify takes documents/findings and returns verifiedFindings; report takes verifiedFindings and returns report. Artifact schemas include evidence references, coverage, and uncertainty where applicable. The report receives verification output that contains those fields.

References use workflow step IDs, not agent definition IDs. This lets the same agent definition run more than once with different inputs. Dependencies are derived from `from: step` bindings, so there is no redundant `dependsOn` list to drift out of sync. Independent ready steps run in parallel within budget. JSON object order does not specify execution order.

The example intentionally shows a minimal linear graph. Adding numerical and missing-evidence specialists creates branches after extraction; connect their findings into verification using a merge binding.

### Combining multiple agents' outputs

For an input whose schema is an array, allow one explicit merge form:

```json
{
  "merge": "concat",
  "sources": [
    { "from": "step", "step": "consistency", "output": "findings" },
    { "from": "step", "step": "financials", "output": "findings" }
  ]
}
```

Both outputs must use the same array schema as the destination. Preserve source-list order and array order; do not silently deduplicate. Findings carry stable IDs and producer lineage. A dependency exists on every source. The `financials` step must be declared in a workflow using this binding; it is omitted from the minimal graph above.

Prefer named outputs for the initial format. For example, an extractor can publish separate `claims` and `metrics` outputs and different agents can consume each one. Defer arbitrary JSON paths, expressions, conditionals, loops, and dynamic agent spawning. If a transformation is needed, first add a typed, tested transformation operation rather than an expression language.

## Runtime persistence

At analysis start, validate and snapshot the entire resolved configuration bundle: workflow, agent definitions, prompts, artifact schemas, model settings, tool versions, and runner version. Hash the actual contents, not just their human version labels. Pin submitted document versions and the authorized case identity independently of configuration.

For each ready step:

1. Resolve input bindings to immutable document/artifact IDs in this run.
2. Recheck access and validate payloads against input contracts.
3. Save a context manifest: source IDs/hashes, resolved payload selection, attachments, instructions, model settings, and any context reduction. Reject oversized required input in v1 instead of silently truncating it.
4. Create an attempt and call the agent through a Convex Workflow action.
5. Validate all outputs; verify referenced sources are authorized and exist. Semantic evidence verification remains the verifier's responsibility.
6. Save output payloads and atomically publish their artifact records together with successful step completion.
7. Return artifact IDs to Convex Workflow and unlock downstream steps.

Use these application records in addition to Convex Workflow's execution history:

- `configurationSnapshots`: immutable bundle/hash used by a run.
- `analysisRuns`: case, submitted versions, configuration snapshot, budget/status.
- `agentRuns`: step ID, agent version, logical execution key, state.
- `agentAttempts`: attempt number, timestamps, errors, usage, diagnostic output references.
- `contextManifests`: exact resolved inputs and model-call context references.
- `artifacts`: output name/schema, producer run/step, payload or storage ID, source lineage, content hash, validation state.

Do not embed large files or model responses in workflow history. Store large content in File Storage and pass IDs. Upload blobs before the publication mutation; clean up unreferenced blobs if a commit fails. Invalid/partial responses are diagnostics, not consumable artifacts. Persist useful tool results during execution; arbitrary streamed tokens are not required durable checkpoints in v1.

Use a run-scoped logical execution key built from run ID, step ID, resolved configuration hash, and input identities/hashes. A transactional claim/attempt token protects against competing or stale attempts. Committing an already accepted result is idempotent. Exactly-once database publication does not guarantee exactly-once external API billing.

## Failure and update semantics

A failed required step blocks its descendants. Independent branches may finish and their artifacts remain inspectable, but the run must not appear complete. Emit an incomplete-run summary from the application with missing stages; do not generate a normal final report from missing inputs in v1. Cancellation rejects late output publication. Retries reuse the same input snapshot and record a new attempt.

Updating configuration affects new runs only. Resuming an interrupted run uses its saved bundle and compatible runner implementation. Intentionally rerunning with changed prompts, wiring, inputs, or model settings creates a new run. Retain supported old runner versions until their active runs finish, or explicitly fail them as incompatible rather than reinterpret saved state.

Cross-run reuse is deferred. Initially `from: step` always means this workflow run. Later reuse must specify exact artifact IDs and verify authorization, input provenance, and configuration compatibility; never fetch another run's vaguely defined “latest” output.

## Validation before activation

Reject unknown format versions/fields, missing registry entries, path escapes, unknown ports, duplicate step identifiers, incompatible schema IDs, cycles/self-dependencies, unreachable steps, invalid merge bindings, unresolved workflow outputs, and limits outside deployment policy. Use a duplicate-key-rejecting JSON loader so duplicate IDs are not silently overwritten before validation. Require all steps to contribute to declared workflow outputs in v1.

Validate configurations in CI and on the server before starting a paid run. End users select approved workflow IDs; they do not upload arbitrary runnable configurations through chat. A later admin editor can use the same format and validators with explicit publication rights.

## Updating behavior

- Change wording: edit the prompt and publish a new agent version.
- Change the model: publish a model profile revision and update agent references.
- Add a specialist: add its definition and a step, then bind its output to a consumer.
- Change who sees what: edit named input bindings.
- Change output shape: publish a schema revision and update connected ports together.

`pnpm config:validate` now checks the local fake bundle. Implement structural/schema validation, a graph compiler, context resolution, and artifact publication before the generic runner. Test cycle/missing-port rejection, parallel fan-in, invalid outputs, restart/retry publication, cancellation, snapshot stability after config edits, and tenant isolation.
