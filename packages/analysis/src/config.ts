import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import {
  parseTree,
  getNodeValue,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import { z } from 'zod';

const name = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9-]*$/)
  .refine((v) => !['constructor', 'prototype'].includes(v));
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const ref = z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]*@\d+\.\d+\.\d+$/);
const port = z.strictObject({ schema: ref });
const inputPort = port.extend({ delivery: z.enum(['attachments', 'json']) });
const registry = <T extends z.ZodType>(type: T) =>
  z
    .record(name, type)
    .refine((value) => Object.keys(value).length > 0, 'Must not be empty');
const base = { formatVersion: z.literal(1), id: name, version };
const inputRef = z.strictObject({ from: z.literal('input'), name });
const stepRef = z.strictObject({
  from: z.literal('step'),
  step: name,
  output: name,
});
const source = z.union([inputRef, stepRef]);
const binding = z.union([
  source,
  z.strictObject({
    merge: z.literal('concat'),
    sources: z.array(source).min(1),
  }),
]);
export const agentSchema = z.strictObject({
  ...base,
  description: z.string().min(1),
  promptFile: z.string().min(1),
  modelProfile: ref,
  inputs: registry(inputPort),
  outputs: registry(port),
  tools: z.array(z.string()).max(0),
  limits: z.strictObject({
    maxModelCalls: z.number().int().min(1).max(20),
    maxInputTokens: z.number().int().min(1).max(200000),
    maxOutputTokensPerCall: z.number().int().min(1).max(16000),
    timeoutSeconds: z.number().int().min(1).max(300),
  }),
  retry: z.strictObject({
    maxAttempts: z.number().int().min(1).max(3),
    on: z.array(z.enum(['rate_limit', 'provider_unavailable'])),
  }),
});
export const modelSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    ...base,
    provider: z.literal('fake'),
    model: z.literal('deterministic-v1'),
  }),
  // A concrete provider model ID. Never an alias that silently changes per run.
  z.strictObject({
    ...base,
    provider: z.literal('xai'),
    model: z.string().regex(/^grok-[a-z0-9][a-z0-9.-]{0,60}$/),
    maxToolCalls: z.number().int().min(1).max(20),
  }),
]);
export type RunnerVersion = 'local-fake-v1' | 'convex-grok-v1';
const runners: Record<z.infer<typeof modelSchema>['provider'], RunnerVersion> =
  { fake: 'local-fake-v1', xai: 'convex-grok-v1' };
/** Provider timeout ceiling enforced by the Grok adapter. */
export const MAX_LIVE_TIMEOUT_SECONDS = 180;
export const workflowSchema = z.strictObject({
  ...base,
  inputs: registry(port),
  limits: z.strictObject({
    maxParallelSteps: z.number().int().min(1).max(8),
    maxModelCalls: z.number().int().min(1).max(100),
  }),
  steps: registry(z.strictObject({ agent: ref, inputs: registry(binding) })),
  outputs: registry(stepRef),
});
export type Source = z.infer<typeof source>;
export type Binding = z.infer<typeof binding>;
export type Agent = z.infer<typeof agentSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type Bundle = {
  runnerVersion: RunnerVersion;
  workflow: Workflow;
  agents: Record<string, Agent>;
  models: Record<string, z.infer<typeof modelSchema>>;
  prompts: Record<string, string>;
  schemas: Record<string, AnySchema>;
};
export function hash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function parseStrictJson(text: string): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
  });
  if (!tree || errors.length) throw new Error('Invalid strict JSON');
  const walk = (node: Node) => {
    if (node.type === 'object') {
      const seen = new Set<string>();
      for (const child of node.children ?? []) {
        const key = String(child.children?.[0]?.value);
        if (seen.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
        seen.add(key);
      }
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  return getNodeValue(tree);
}
export function loadBundle(
  root: string,
  workflowFile = 'workflows/diligence.v1.json',
): Bundle {
  const directory = realpathSync(root);
  const read = (path: string) => {
    const target = realpathSync(resolve(directory, path));
    const rel = relative(directory, target);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Config path escapes root');
    return readFileSync(target, 'utf8');
  };
  const agents: Bundle['agents'] = {},
    models: Bundle['models'] = {},
    schemas: Bundle['schemas'] = {},
    prompts: Bundle['prompts'] = {};
  for (const file of readdirSync(resolve(directory, 'agents'))
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const agent = agentSchema.parse(parseStrictJson(read(`agents/${file}`)));
    const key = `${agent.id}@${agent.version}`;
    if (Object.hasOwn(agents, key)) throw new Error(`Duplicate agent: ${key}`);
    agents[key] = agent;
    prompts[agent.promptFile] = read(agent.promptFile);
  }
  for (const file of readdirSync(resolve(directory, 'models'))
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const model = modelSchema.parse(parseStrictJson(read(`models/${file}`)));
    const key = `${model.id}@${model.version}`;
    if (Object.hasOwn(models, key)) throw new Error(`Duplicate model: ${key}`);
    models[key] = model;
  }
  for (const file of readdirSync(resolve(directory, 'schemas'))
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const schema = parseStrictJson(read(`schemas/${file}`));
    const id = ref.parse((schema as { $id?: unknown })?.$id);
    if (Object.hasOwn(schemas, id)) throw new Error(`Duplicate schema: ${id}`);
    schemas[id] = schema as AnySchema;
  }
  const workflow = workflowSchema.parse(parseStrictJson(read(workflowFile)));
  // Snapshot only what this workflow uses, so unrelated config edits keep its hash.
  const pick = <T>(from: Record<string, T>, key: string, kind: string) => {
    if (!Object.hasOwn(from, key)) throw new Error(`Unknown ${kind}: ${key}`);
    return from[key]!;
  };
  const used: Omit<Bundle, 'runnerVersion' | 'workflow'> = {
    agents: {},
    models: {},
    prompts: {},
    schemas: {},
  };
  const useSchema = (id: string) =>
    (used.schemas[id] = pick(schemas, id, 'schema'));
  Object.values(workflow.inputs).forEach((p) => useSchema(p.schema));
  for (const step of Object.values(workflow.steps)) {
    const agent = (used.agents[step.agent] = pick(agents, step.agent, 'agent'));
    used.models[agent.modelProfile] = pick(models, agent.modelProfile, 'model');
    used.prompts[agent.promptFile] = prompts[agent.promptFile]!;
    [...Object.values(agent.inputs), ...Object.values(agent.outputs)].forEach(
      (p) => useSchema(p.schema),
    );
  }
  const providers = new Set(Object.values(used.models).map((m) => m.provider));
  if (providers.size !== 1)
    throw new Error('A workflow must use exactly one model provider');
  const sorted = <T>(value: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    );
  const bundle: Bundle = {
    runnerVersion: runners[[...providers][0]!],
    workflow,
    agents: sorted(used.agents),
    models: sorted(used.models),
    prompts: sorted(used.prompts),
    schemas: sorted(used.schemas),
  };
  compile(bundle);
  return bundle;
}
export const sources = (value: Binding): Source[] =>
  'merge' in value ? value.sources : [value];
export function compile(bundle: Bundle) {
  if (!Object.values(runners).includes(bundle.runnerVersion))
    throw new Error('Unsupported runner version');
  const live = bundle.runnerVersion === 'convex-grok-v1';
  const workflow = workflowSchema.parse(bundle.workflow);
  const ajv = new Ajv({ strict: true, allErrors: true });
  const validators: Record<string, ValidateFunction> = {};
  for (const [id, schema] of Object.entries(bundle.schemas))
    ajv.addSchema(schema, id);
  for (const id of Object.keys(bundle.schemas)) {
    ref.parse(id);
    const validate = ajv.getSchema(id);
    if (!validate) throw new Error(`Missing schema: ${id}`);
    validators[id] = validate;
  }
  const ensureSchema = (id: string) => {
    if (!Object.hasOwn(validators, id))
      throw new Error(`Unknown schema: ${id}`);
  };
  for (const [id, value] of Object.entries(bundle.models)) {
    const model = modelSchema.parse(value);
    if (id !== `${model.id}@${model.version}`)
      throw new Error('Model key mismatch');
    if (runners[model.provider] !== bundle.runnerVersion)
      throw new Error('Model provider does not match runner');
  }
  for (const [id, value] of Object.entries(bundle.agents)) {
    const agent = agentSchema.parse(value);
    if (id !== `${agent.id}@${agent.version}`)
      throw new Error('Agent key mismatch');
    if (!Object.hasOwn(bundle.models, agent.modelProfile))
      throw new Error(`Unknown model: ${agent.modelProfile}`);
    if (
      !Object.hasOwn(bundle.prompts, agent.promptFile) ||
      !bundle.prompts[agent.promptFile]?.trim()
    )
      throw new Error('Missing prompt');
    [...Object.values(agent.inputs), ...Object.values(agent.outputs)].forEach(
      (p) => ensureSchema(p.schema),
    );
    if (agent.retry.maxAttempts > agent.limits.maxModelCalls)
      throw new Error('Attempts exceed agent call budget');
    if (live && agent.limits.timeoutSeconds > MAX_LIVE_TIMEOUT_SECONDS)
      throw new Error(`Live timeout exceeds ${MAX_LIVE_TIMEOUT_SECONDS}s`);
  }
  Object.values(workflow.inputs).forEach((p) => ensureSchema(p.schema));
  const agentFor = (id: string) => {
    const step = Object.hasOwn(workflow.steps, id)
      ? workflow.steps[id]
      : undefined;
    const agent =
      step && Object.hasOwn(bundle.agents, step.agent)
        ? bundle.agents[step.agent]
        : undefined;
    if (!agent) throw new Error(`Unknown step or agent: ${id}`);
    return agent;
  };
  const sourceSchema = (s: Source) => {
    const ports =
      s.from === 'input' ? workflow.inputs : agentFor(s.step).outputs;
    const key = s.from === 'input' ? s.name : s.output;
    if (!Object.hasOwn(ports, key))
      throw new Error('Unknown input or output port');
    return ports[key]!.schema;
  };
  const dependencies: Record<string, string[]> = {};
  for (const [id, step] of Object.entries(workflow.steps)) {
    const agent = agentFor(id);
    if (
      Object.keys(step.inputs).sort().join('|') !==
      Object.keys(agent.inputs).sort().join('|')
    )
      throw new Error(`Input ports mismatch: ${id}`);
    const deps = new Set<string>();
    for (const [portName, binding] of Object.entries(step.inputs)) {
      const schemaId = agent.inputs[portName]!.schema;
      // The live runtime attaches only authorized submitted document versions.
      if (
        live &&
        agent.inputs[portName]!.delivery === 'attachments' &&
        ('merge' in binding || binding.from !== 'input')
      )
        throw new Error(`Attachments must bind a submitted input: ${id}`);
      if (
        'merge' in binding &&
        (bundle.schemas[schemaId] as { type?: string }).type !== 'array'
      )
        throw new Error('Concat requires an array schema');
      for (const s of sources(binding)) {
        if (sourceSchema(s) !== schemaId)
          throw new Error(`Schema mismatch: ${id}.${portName}`);
        if (s.from === 'step') deps.add(s.step);
      }
    }
    dependencies[id] = [...deps];
  }
  Object.values(workflow.outputs).forEach(sourceSchema);
  const order: string[] = [],
    active = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new Error(`Cycle: ${id}`);
    if (visited.has(id)) return;
    active.add(id);
    dependencies[id]!.forEach(visit);
    active.delete(id);
    visited.add(id);
    order.push(id);
  };
  Object.keys(workflow.steps).forEach(visit);
  const used = new Set<string>();
  const mark = (id: string) => {
    if (used.has(id)) return;
    used.add(id);
    dependencies[id]!.forEach(mark);
  };
  Object.values(workflow.outputs).forEach((s) => mark(s.step));
  if (used.size !== order.length)
    throw new Error('Workflow contains unused steps');
  return { workflow, dependencies, order, validators };
}
