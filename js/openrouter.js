// The one place that talks to a model through OpenRouter.
// Both functions return OpenRouter's whole JSON reply, so you can see
// everything that comes back (the text, token counts and cost).

const MODEL = 'google/gemini-2.5-flash-lite';

async function askModel(prompt) {
  return chat([{ role: 'user', content: prompt }]);
}

/**
 * Send a list of messages ({ role: 'system' | 'user' | 'assistant', content }).
 * Options: model, maxTokens (a safety cap on the reply), temperature (0 = most predictable),
 * responseFormat (e.g. { type: 'json_schema', json_schema: {...} } to get JSON back).
 */
async function chat(messages, { model = MODEL, maxTokens, temperature, responseFormat } = {}) {
  if (typeof OPENROUTER_API_KEY === 'undefined' || OPENROUTER_API_KEY.startsWith('YOUR_')) {
    throw new Error('No API key. Copy js/config.local.example.js to js/config.local.js and paste your key in.');
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      response_format: responseFormat,
    }),
  });

  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.message || response.statusText);
  return data;
}
