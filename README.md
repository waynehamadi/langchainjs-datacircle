# Datacircle tools for LangChain.js

Find the best GTM APIs. We benchmark all the GTM APIs and we put the results on our website.

Our website: https://datacircle.dev

This package gives [LangChain.js](https://js.langchain.com) four tools that call Datacircle's open API, https://api.datacircle.dev/v1. You need no key and no account.

| Tool | What the tool gives | Call |
| --- | --- | --- |
| `datacircle_list_apis` | Every GTM API on Datacircle, with the API's slug, number of plans, number of providers and best plan | `GET /apis` |
| `datacircle_best_plans` | One API's plans, sorted by score out of 100, best first. Each plan comes with a rank and a price per 1,000 calls | `GET /apis/{slug}/best` |
| `datacircle_search_plans` | Plans that match a provider or plan name, on all APIs or on one API. You can sort them by score, provider or price | `GET /plans` |
| `datacircle_provider` | The APIs a provider sells, and the provider's rank on each API | `GET /providers/{slug}` |

## Install

```bash
npm install @datacircle/langchain @langchain/core zod
```

The package works with LangChain.js 1.x (`@langchain/core` 1.0.0 and later) and zod 3.25 or 4. It works from ESM and from CommonJS.

## Use the tools

Give the tools to an agent. This example also needs `langchain` and `@langchain/openai`:

```ts
import { createAgent } from 'langchain';
import { datacircleTools } from '@datacircle/langchain';

const agent = createAgent({
  model: 'openai:gpt-5-mini',
  tools: datacircleTools(),
  systemPrompt: 'You find the best GTM APIs for the user.',
});

const result = await agent.invoke({
  messages: [{ role: 'user', content: 'Who are the 3 best providers for the email-finder API?' }],
});
console.log(result.messages.at(-1)?.text);
```

`new DatacircleToolkit().getTools()` gives the same four tools as a LangChain toolkit. Any chat model that calls tools takes them with `model.bindTools(datacircleTools())`.

You can call each tool alone: `listApis()`, `bestPlans()`, `searchPlans()` and `providerRanks()`.

```ts
import { bestPlans } from '@datacircle/langchain';

const answer = await bestPlans().invoke({ slug: 'email-finder', limit: 3 });
console.log(answer.plans);
```

Each tool gives back a JSON object. An agent gets it as a JSON string in a `ToolMessage`. Each plan comes with a rank, provider, plan, score, price per 1,000 (`perThousand`, in dollars) and a page on datacircle.dev. That page lists every field. When the API gives no data, for example for an unknown slug, the tool returns `{"error": "..."}` with the API's message. The model can then call again. When the input does not fit the schema, the agent gives the model LangChain's validation error. If the network fails, the tool throws an error.

`datacircleTools({ fetch })` sets the `fetch` the tools use, for example to add a proxy or a timeout. The toolkit and each tool function take the same options.

## Network

Each tool call makes one HTTPS GET request to https://api.datacircle.dev/v1 and nothing else. The request holds only the tool's own arguments: no key and nothing from your chats. The API takes up to 60 calls a minute from one IP address. The tool waits once, for a minute at most, when the API asks the tool to wait. The package depends only on `@langchain/core` and zod, and stores nothing.

## Links

- Datacircle: https://datacircle.dev
- The API: https://datacircle.dev/api
- The API's spec: https://api.datacircle.dev/v1/openapi.json
- What each key means: https://datacircle.dev/fields

MIT license.
