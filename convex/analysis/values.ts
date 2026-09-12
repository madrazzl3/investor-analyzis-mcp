import { v } from 'convex/values';
export const runStatus = v.union(
  v.literal('queued'),
  v.literal('running'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('cancelled'),
);
export const runMode = v.union(v.literal('synthetic'), v.literal('live'));
export const stepStatus = v.union(
  v.literal('pending'),
  v.literal('running'),
  v.literal('completed'),
  v.literal('failed'),
);
export const artifactRefs = v.record(v.string(), v.id('artifacts'));
const tokens = v.union(v.number(), v.null());
export const providerCall = v.object({
  model: v.string(),
  responseId: v.string(),
  usage: v.object({
    inputTokens: tokens,
    outputTokens: tokens,
    totalTokens: tokens,
  }),
});
