// Each tool's own invoke on the live API, through LangChain's own input check: its four calls and the answers a model's
// mistakes get, and the ToolMessage an agent's tool call gets. npm test
import { ToolInputParsingException } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { DatacircleToolkit, datacircleTools, listApis, bestPlans, searchPlans, providerRanks } from '@datacircle/langchain';

const [listTool, bestTool, searchTool, providerTool] = datacircleTools();
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failed++;
};
// The tool's invoke as LangChain gives it: the input checked by the tool's schema first, its answer, or the check's error.
const run = async (t, input) => {
  try {
    return await t.invoke(input);
  } catch (error) {
    return { thrown: error };
  }
};

let r = await run(listTool, {});
check('list_apis', r.total > 100 && r.apis.length === 20 && r.apis[0].slug, `total ${r.total}, first ${r.apis[0]?.slug}`);
r = await run(listTool, { query: 'email', limit: '3' });
check('list_apis email, limit as a string', r.apis?.length === 3 && r.apis.every((a) => /email/i.test(a.api + a.slug)) && !r.note, r.apis?.map((a) => a.slug).join(', '));
r = await run(listTool, { query: 'Bright Data' });
check('list_apis provider name', typeof r.note === 'string' && r.note.includes('datacircle_search_plans'), r.note);

r = await run(bestTool, { slug: 'email-finder', limit: 3 });
check('best_plans', r.plans.length === 3 && r.plans[0].rank === 1 && typeof r.plans[0].score === 'number' && r.plans[0].page && !('aggregators' in r.plans[0]),
  `${r.api}: ${r.plans.map((p) => `${p.rank}. ${p.provider} ${p.score}`).join(' / ')}`);
r = await run(bestTool, { slug: 'Email Finder', limit: 99 });
check('best_plans name, limit 99', r.plans?.length >= 10 && r.slug === 'email-finder', `${r.plans?.length} plans`);
r = await run(bestTool, { slug: 'bright-data' });
check('best_plans unknown slug', r.error?.startsWith('no API has the slug bright-data') && r.error.includes('datacircle_search_plans') && !r.slugs, r.error);
r = await run(bestTool, { slug: '' });
check('best_plans empty slug', r.error?.startsWith("Give an API's slug"), r.error);
r = await run(bestTool, {});
check('best_plans no slug: the input check refuses it', r.thrown instanceof ToolInputParsingException && /slug/.test(r.thrown.message), r.thrown?.message?.split('\n')[0]);

r = await run(searchTool, { query: 'bright data', sort: 'price', limit: 5 });
check('search_plans', r.total > 0 && r.plans.length === 5 && r.plans.every((p) => /bright data/i.test(p.provider)), `total ${r.total}, cheapest ${r.plans[0]?.perThousand}`);
r = await run(searchTool, { api: 'email-finder', limit: 2, offset: 1 });
check('search_plans api offset', r.plans.length === 2 && r.plans[0].rank === 2, r.plans.map((p) => `${p.rank}. ${p.provider}`).join(' / '));
r = await run(searchTool, { api: 'Bright Data' });
check('search_plans provider as api', r.total > 0 && r.note?.startsWith('No API is named'), `total ${r.total}: ${r.note}`);
r = await run(searchTool, { query: 'bright-data' });
check('search_plans slug as query', r.total > 0 && r.note?.includes('"bright data"'), `total ${r.total}: ${r.note}`);
r = await run(searchTool, { offset: -3, limit: 0 });
check('search_plans out of range: the defaults', r.plans?.length === 10, `${r.plans?.length} plans`);
r = await run(searchTool, { sort: 'cheapest' });
check('search_plans bad sort: the input check refuses it', r.thrown instanceof ToolInputParsingException && /sort/.test(r.thrown.message), r.thrown?.message?.split('\n')[0]);

r = await run(providerTool, { slug: 'Bright Data' });
check('provider', r.slug === 'bright-data' && r.total > 10 && r.ranked > 0 && r.apis[0].rank <= r.apis[1].rank && r.apis[0].best?.plan,
  `${r.provider}: ${r.total} APIs, ranked on ${r.ranked}, best ${r.apis[0].api} #${r.apis[0].rank}`);
r = await run(providerTool, { slug: 'nobody-x' });
check('provider unknown', r.error?.startsWith('no provider has the slug nobody-x'), r.error);

// A tool call as an agent sends it: a ToolMessage whose content is the answer as JSON.
r = await run(bestTool, { type: 'tool_call', id: 'call_1', name: 'datacircle_best_plans', args: { slug: 'serp', limit: 2 } });
const content = r instanceof ToolMessage ? JSON.parse(r.content) : null;
check('tool call: a ToolMessage', r instanceof ToolMessage && r.tool_call_id === 'call_1' && r.name === 'datacircle_best_plans' && content?.plans?.length === 2,
  `${r.constructor?.name} ${String(r.content).slice(0, 80)}`);

// The toolkit and the single tools are the same tools.
const names = new DatacircleToolkit().getTools().map((t) => t.name).join(',');
check('toolkit', names === 'datacircle_list_apis,datacircle_best_plans,datacircle_search_plans,datacircle_provider', names);
for (const [name, t, input] of [['listApis', listApis(), { limit: 1 }], ['bestPlans', bestPlans(), { slug: 'serp', limit: 1 }],
  ['searchPlans', searchPlans(), { limit: 1 }], ['providerRanks', providerRanks(), { slug: 'bright-data' }]]) {
  r = await run(t, input);
  check(name, !r.error && (r.apis ?? r.plans)?.length > 0 && t.name === `datacircle_${name === 'providerRanks' ? 'provider' : name.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())}`, `${t.name}: ${Object.keys(r).join(',')}`);
}

// Each call's User-Agent, through a fetch of the app's own.
const seen = [];
const [, traced] = datacircleTools({ fetch: (url, init) => (seen.push([String(url), init.headers['User-Agent']]), fetch(url, init)) });
await run(traced, { slug: 'serp', limit: 1 });
check('fetch option', seen.length === 1 && seen[0][0] === 'https://api.datacircle.dev/v1/apis/serp/best?limit=1' && seen[0][1] === 'datacircle-langchainjs/0.1.0', seen.flat().join(' '));

// An abort signal of the run's config stops the call.
const controller = new AbortController();
controller.abort(new Error('stopped'));
r = await bestTool.invoke({ slug: 'serp' }, { signal: controller.signal }).then(() => null, (error) => error);
check('abort signal', r instanceof Error, String(r?.message));

console.log(failed === 0 ? 'ALL OK' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
