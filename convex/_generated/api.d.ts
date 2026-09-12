/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as analysis_execute from "../analysis/execute.js";
import type * as analysis_fake from "../analysis/fake.js";
import type * as analysis_registry from "../analysis/registry.js";
import type * as analysis_state from "../analysis/state.js";
import type * as analysis_validators from "../analysis/validators.js";
import type * as analysis_values from "../analysis/values.js";
import type * as analysis_workflow from "../analysis/workflow.js";
import type * as auth from "../auth.js";
import type * as cases from "../cases.js";
import type * as crons from "../crons.js";
import type * as devFixtures from "../devFixtures.js";
import type * as documents from "../documents.js";
import type * as http from "../http.js";
import type * as identity from "../identity.js";
import type * as mcpBridge from "../mcpBridge.js";
import type * as mcpConfig from "../mcpConfig.js";
import type * as mcpConnections from "../mcpConnections.js";
import type * as mcpOAuth from "../mcpOAuth.js";
import type * as organizations from "../organizations.js";
import type * as providerFiles from "../providerFiles.js";
import type * as runs from "../runs.js";
import type * as uploadValidation from "../uploadValidation.js";
import type * as uploads from "../uploads.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  "analysis/execute": typeof analysis_execute;
  "analysis/fake": typeof analysis_fake;
  "analysis/registry": typeof analysis_registry;
  "analysis/state": typeof analysis_state;
  "analysis/validators": typeof analysis_validators;
  "analysis/values": typeof analysis_values;
  "analysis/workflow": typeof analysis_workflow;
  auth: typeof auth;
  cases: typeof cases;
  crons: typeof crons;
  devFixtures: typeof devFixtures;
  documents: typeof documents;
  http: typeof http;
  identity: typeof identity;
  mcpBridge: typeof mcpBridge;
  mcpConfig: typeof mcpConfig;
  mcpConnections: typeof mcpConnections;
  mcpOAuth: typeof mcpOAuth;
  organizations: typeof organizations;
  providerFiles: typeof providerFiles;
  runs: typeof runs;
  uploadValidation: typeof uploadValidation;
  uploads: typeof uploads;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
