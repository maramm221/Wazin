// Optional LLM adapters for Tier-3 extraction. Wazin works without any of them;
// with one configured, free-text invoices (emails, OCR output) are read too.

/** Anthropic Messages API (Node or server-side). */
export function anthropicLLM({ apiKey = globalThis.process?.env?.ANTHROPIC_API_KEY, model = globalThis.process?.env?.WAZIN_MODEL || 'claude-haiku-5-5' } = {}) {
  if (!apiKey) return undefined;
  return async (prompt) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content.map((c) => c.text || '').join('');
  };
}

/** OpenAI-compatible chat endpoint — e.g. a self-hosted ALLaM or any vLLM server. */
export function openAICompatibleLLM({ baseUrl, apiKey, model }) {
  return async (prompt) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content;
  };
}
