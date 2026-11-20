// The package as CommonJS loads it: require() gives the same tools, and one calls the live API. npm test
const { DatacircleToolkit, datacircleTools, VERSION } = require('@datacircle/langchain');

(async () => {
  const names = new DatacircleToolkit().getTools().map((t) => t.name).join(',');
  const r = await datacircleTools()[1].invoke({ slug: 'email-finder', limit: 2 });
  const ok = names === 'datacircle_list_apis,datacircle_best_plans,datacircle_search_plans,datacircle_provider' && r.plans?.length === 2 && VERSION === '0.1.0';
  console.log(`${ok ? 'ok  ' : 'FAIL'} require: ${names}; ${r.api}: ${r.plans?.map((p) => `${p.rank}. ${p.provider}`).join(' / ')}`);
  process.exit(ok ? 0 : 1);
})();
