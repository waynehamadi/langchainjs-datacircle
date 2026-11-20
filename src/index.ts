// LangChain.js tools on Datacircle's open API: find the best GTM APIs. The API needs no key: https://api.datacircle.dev/v1
// (its spec: https://api.datacircle.dev/v1/openapi.json). More at https://datacircle.dev

import { BaseToolkit, tool } from '@langchain/core/tools';
import type { DynamicStructuredTool, ToolSchemaBase } from '@langchain/core/tools';
import { z } from 'zod';
import { ApiError, BASE_URL, Client, VERSION, brief, briefPlans, clamp, objects, slugify } from './client.js';
import type { Answer, DatacircleOptions } from './client.js';

export { ApiError, BASE_URL, VERSION };
export type { Answer, DatacircleOptions };

const LIST_APIS_ABOUT = "Lists the GTM APIs on Datacircle's sheet (https://datacircle.dev). GTM means go-to-market. GTM APIs are the APIs sales and marketing teams use. Gives each API's slug, how many plans and providers it has and its best plan. Call it first to find an API's slug.";
const BEST_PLANS_ABOUT = "Gives an API's plans best first by their score out of 100 on Datacircle's benchmark (https://datacircle.dev), each with its rank, provider, plan, $ per 1,000 calls and its page. perThousand is a plan's price of 1,000 items in dollars, pay the plan's whole price in its currency.";
const SEARCH_PLANS_ABOUT = "Searches every plan on Datacircle's sheet (https://datacircle.dev), or one API's, by provider or plan name, sorted by score, provider or price. Gives how many were found and up to limit of them. perThousand is a plan's price of 1,000 items in dollars, pay the plan's whole price in its currency.";
const PROVIDER_ABOUT = "Gives each API one provider sells and its rank on each on Datacircle's benchmark (https://datacircle.dev), with its best plan there, its best rank first. total is how many APIs it sells, ranked on how many of them it has a rank.";

// Tells a model that sent a provider's name to an API's tool where a provider's plans are.
const FOR_PROVIDER = "A provider's plans: datacircle_search_plans with its name as query, like bright data, or datacircle_provider.";

// A number sent as a string is read as one, a fraction cut to its whole part. A limit or an offset below 1 takes its default.
const count = (description: string) => z.coerce.number().optional().describe(description);
const text = (description: string) => z.string().optional().describe(description);

const listApisInput = z.object({
  query: text("Words of the API's name or slug, like email or linkedin profile: the APIs that hold the most of them come first. The sheet's order when left out"),
  limit: count('How many APIs to give, 1 to 200. 20 when left out: the sheet has about 150'),
});

const bestPlansInput = z.object({
  slug: z.string().describe("The API's slug, like email-finder or linkedin-profile, as datacircle_list_apis gives it"),
  limit: count('How many plans to give, 1 to 50. 10 when left out'),
});

const searchPlansInput = z.object({
  api: text("Only this API's plans: its name or slug, like email-finder. A provider's name goes in query, never here. Every API when left out"),
  query: text("Words that must all appear in the provider's or plan's name, like bright data"),
  sort: z.enum(['score', 'provider', 'price']).optional().describe('score (best first, the default), provider (A to Z) or price ($ per 1,000, lowest first)'),
  limit: count('How many plans to give, 1 to 50. 10 when left out'),
  offset: count('How many found plans to skip first. 0 when left out'),
});

const providerInput = z.object({
  slug: z.string().describe("The provider's slug, like bright-data, or its name, like Bright Data: the name is made a slug"),
});

/** datacircle_list_apis' input. */
export type ListApisInput = { query?: string; limit?: number };
/** datacircle_best_plans' input. */
export type BestPlansInput = { slug: string; limit?: number };
/** datacircle_search_plans' input. */
export type SearchPlansInput = { api?: string; query?: string; sort?: 'score' | 'provider' | 'price'; limit?: number; offset?: number };
/** datacircle_provider's input. */
export type ProviderInput = { slug: string };

/**
 * A LangChain.js tool of ours, by its input and its name. invoke(input) gives the answer as a JSON object; invoke(toolCall),
 * as an agent calls it, gives a ToolMessage holding that object as JSON.
 */
export type DatacircleTool<Input, Name extends string = string> = DynamicStructuredTool<ToolSchemaBase, Input, Input, Answer, unknown, Name>;

// What LangChain gives a tool's function after its input: the run's config, or an agent's runtime holding it.
type Runtime = { signal?: AbortSignal; config?: { signal?: AbortSignal } } | undefined;
const signalOf = (runtime: Runtime) => runtime?.signal ?? runtime?.config?.signal;

/** A limit the model sent, within the API's bounds, or undefined for the API's default. */
const bounded = (n: number | undefined, high: number) => (n === undefined || n < 1 ? undefined : clamp(n, 1, high));

/** An answer of 4xx (an unknown slug, a wrong argument) is the tool's result as {error}, so that the model reads the API's words and can call again. */
function asResult(error: unknown): Answer {
  if (error instanceof ApiError) return { error: error.message };
  throw error;
}

async function listApisRun(client: Client, { query, limit }: ListApisInput, signal?: AbortSignal): Promise<Answer> {
  let apis: Answer[];
  try {
    apis = objects(await client.get<unknown>('/apis', {}, signal));
  } catch (error) {
    return asResult(error);
  }
  const words = (query ?? '').toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const found = apis
    .map((api, order) => {
      const name = `${String(api.api ?? '')} ${String(api.slug ?? '').replace(/-/g, ' ')}`.toLowerCase();
      return { order, matched: words.filter((word) => name.includes(word)).length, api };
    })
    .filter(({ matched }) => matched > 0 || words.length === 0)
    // The most words matched first, the sheet's order within each.
    .sort((a, b) => b.matched - a.matched || a.order - b.order);
  const answer: Answer = {
    total: found.length,
    apis: found.slice(0, bounded(limit, 200) ?? 20)
      .map(({ api }) => brief(api, ['api', 'slug', 'plans', 'providers', 'best', 'bestPage', 'sheetPage'])),
  };
  if (words.length > 0 && (found.length === 0 || found[0].matched < words.length)) {
    // A provider's name sent as an API's, like Bright Data, whose data matches many APIs: where its plans are.
    answer.note = `No API's name holds every word of ${JSON.stringify(query)}. A provider's plans: datacircle_search_plans with its name as query, or datacircle_provider.`;
  }
  return answer;
}

async function bestPlansRun(client: Client, { slug, limit }: BestPlansInput, signal?: AbortSignal): Promise<Answer> {
  const api = slugify(slug ?? '');
  if (api === '') return { error: `Give an API's slug, like email-finder: datacircle_list_apis gives every slug. ${FOR_PROVIDER}` };
  try {
    const answer = await client.get(`/apis/${api}/best`, { limit: bounded(limit, 50) }, signal);
    return { ...answer, plans: briefPlans(answer.plans) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // A provider's name sent as the API's slug: the API's words, and where a provider's plans are.
      return { error: `${error.message}. datacircle_list_apis gives every API's slug. ${FOR_PROVIDER}` };
    }
    return asResult(error);
  }
}

async function searchPlansRun(client: Client, input: SearchPlansInput, signal?: AbortSignal): Promise<Answer> {
  const search = (api: string, query: string) =>
    client.get('/plans', {
      api: api.trim(),
      query: query.trim(),
      sort: input.sort,
      limit: bounded(input.limit, 50),
      offset: input.offset === undefined || input.offset <= 0 ? undefined : Math.trunc(input.offset),
    }, signal);
  let api = input.api ?? '';
  let query = input.query ?? '';
  const notes: string[] = [];
  try {
    let answer: Answer;
    try {
      answer = await search(api, query);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 400 && error.message.includes('api must be') && query.trim() === '')) throw error;
      // A provider's name sent as the API: the plans whose provider or plan name holds it.
      [api, query] = ['', api];
      answer = await search(api, query);
      notes.push(`No API is named ${JSON.stringify(input.api)}: these are the plans whose provider or plan name holds it.`);
    }
    if (answer.total === 0 && query.includes('-')) {
      // A slug sent as a name, like bright-data, which no name holds: its words, like bright data. A name with a
      // hyphen, like A-Leads, is found as it is first.
      const words = query.replace(/-/g, ' ').split(/\s+/).filter(Boolean).join(' ');
      try {
        answer = await search(api, words);
        notes.push(`No provider's or plan's name holds ${JSON.stringify(query)}: these are the plans whose name holds ${JSON.stringify(words)}.`);
      } catch {
        // The first answer stands.
      }
    }
    return { ...answer, plans: briefPlans(answer.plans), ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
  } catch (error) {
    return asResult(error);
  }
}

async function providerRun(client: Client, { slug }: ProviderInput, signal?: AbortSignal): Promise<Answer> {
  const provider = slugify(slug ?? '');
  if (provider === '') return { error: "Give a provider's slug or name, like bright-data or Bright Data" };
  let answer: Answer;
  try {
    answer = await client.get(`/providers/${provider}`, {}, signal);
  } catch (error) {
    return asResult(error);
  }
  const apis = objects(answer.apis).map((entry) => {
    const plans = objects(entry.plans);
    const kept: Answer = { ...brief(entry, ['api', 'slug', 'rank', 'bestPage']), plans: plans.length };
    const best = bestPlan(plans);
    if (best) kept.best = brief(best, ['plan', 'score', 'perThousand', 'page']);
    return kept;
  });
  // Its best rank first, the APIs where it has none last, in the API's order.
  const rank = (api: Answer) => (typeof api.rank === 'number' ? api.rank : Infinity);
  apis.sort((a, b) => rank(a) - rank(b));
  return { ...answer, apis, total: apis.length, ranked: apis.filter((api) => typeof api.rank === 'number').length };
}

/** A provider's best plan on an API: its lowest rank, the first when none has a rank. */
function bestPlan(plans: Answer[]): Answer | undefined {
  const ranked = plans.filter((plan) => typeof plan.rank === 'number');
  if (ranked.length === 0) return plans[0];
  return ranked.reduce((best, plan) => ((plan.rank as number) < (best.rank as number) ? plan : best));
}

// Each tool is typed by its input and name alone, so that its type holds whichever zod and @langchain/core 1.x the app has.
const listApisTool = (client: Client) =>
  tool((input: ListApisInput, runtime: Runtime) => listApisRun(client, input ?? {}, signalOf(runtime)), {
    name: 'datacircle_list_apis',
    description: LIST_APIS_ABOUT,
    schema: listApisInput,
  }) as unknown as DatacircleTool<ListApisInput, 'datacircle_list_apis'>;

const bestPlansTool = (client: Client) =>
  tool((input: BestPlansInput, runtime: Runtime) => bestPlansRun(client, input ?? { slug: '' }, signalOf(runtime)), {
    name: 'datacircle_best_plans',
    description: BEST_PLANS_ABOUT,
    schema: bestPlansInput,
  }) as unknown as DatacircleTool<BestPlansInput, 'datacircle_best_plans'>;

const searchPlansTool = (client: Client) =>
  tool((input: SearchPlansInput, runtime: Runtime) => searchPlansRun(client, input ?? {}, signalOf(runtime)), {
    name: 'datacircle_search_plans',
    description: SEARCH_PLANS_ABOUT,
    schema: searchPlansInput,
  }) as unknown as DatacircleTool<SearchPlansInput, 'datacircle_search_plans'>;

const providerTool = (client: Client) =>
  tool((input: ProviderInput, runtime: Runtime) => providerRun(client, input ?? { slug: '' }, signalOf(runtime)), {
    name: 'datacircle_provider',
    description: PROVIDER_ABOUT,
    schema: providerInput,
  }) as unknown as DatacircleTool<ProviderInput, 'datacircle_provider'>;

/** The four tools, in this order. Their answers name each other by these names. */
export type DatacircleTools = [
  DatacircleTool<ListApisInput, 'datacircle_list_apis'>,
  DatacircleTool<BestPlansInput, 'datacircle_best_plans'>,
  DatacircleTool<SearchPlansInput, 'datacircle_search_plans'>,
  DatacircleTool<ProviderInput, 'datacircle_provider'>,
];

/**
 * The four tools, for createAgent's tools or a model's bindTools: datacircle_list_apis (GET /apis), datacircle_best_plans
 * (GET /apis/{slug}/best), datacircle_search_plans (GET /plans) and datacircle_provider (GET /providers/{slug}).
 */
export function datacircleTools(options?: DatacircleOptions): DatacircleTools {
  const client = new Client(options);
  return [listApisTool(client), bestPlansTool(client), searchPlansTool(client), providerTool(client)];
}

/** The four tools as a LangChain toolkit: new DatacircleToolkit().getTools(). */
export class DatacircleToolkit extends BaseToolkit {
  // Typed as our four, not as any toolkit's tools, so that an agent takes them beside tools of other kinds.
  tools: DatacircleTools;

  constructor(options?: DatacircleOptions) {
    super();
    this.tools = datacircleTools(options);
  }

  getTools(): DatacircleTools {
    return this.tools;
  }
}

/** datacircle_list_apis alone: GET /apis. */
export const listApis = (options?: DatacircleOptions) => listApisTool(new Client(options));

/** datacircle_best_plans alone: GET /apis/{slug}/best. */
export const bestPlans = (options?: DatacircleOptions) => bestPlansTool(new Client(options));

/** datacircle_search_plans alone: GET /plans. */
export const searchPlans = (options?: DatacircleOptions) => searchPlansTool(new Client(options));

/** datacircle_provider alone: GET /providers/{slug}. */
export const providerRanks = (options?: DatacircleOptions) => providerTool(new Client(options));
