// background/remoteClient.js
//
// Optional remote reasoning step (spec section 11). Uses a plain
// OpenAI-generic-compatible /chat/completions call rather than
// Magnitude's BAML-generated client, because BAML's runtime is a
// Rust-compiled native/WASM component generated from baml_src/*.baml —
// not something that can run inside a Chrome extension's JS sandbox
// without a much larger porting effort. The `openai-generic` provider
// shape from packages/magnitude-core/src/ai/types.ts (model, baseUrl,
// apiKey, headers) is preserved here so existing self-hosted / proxy
// endpoints users already run for Magnitude can be reused unchanged.
//
// CRITICAL INVARIANT: this module must only ever be called with data
// that has already passed through shared/privacyGate.js. It does not
// re-check sensitivity — that is the gate's job, not this client's.

export async function callRemoteReasoner({ endpoint, apiKey, model, sanitizedContext, sanitizedScreenshot, actionSchemaDescription }) {
  if (!endpoint) throw new Error('No remote endpoint configured');

  const systemPrompt = [
    'You are a browser-automation planner. You will be given a SANITIZED',
    'description of a web page (sensitive values have been redacted before',
    'reaching you) and, optionally, a sanitized screenshot. Sensitive field',
    'values are never available to you and must never be requested or',
    'guessed. If a field must be filled with sensitive data, emit a',
    '"local:fill_credential" action naming only the credential ROLE',
    '(e.g. "aadhaar_number", "otp", "password") — never a value.',
    'Respond with a JSON action plan only: { actions: Action[], done: boolean, confidence: number }.',
    actionSchemaDescription
  ].join(' ');

  const userContent = [{ type: 'text', text: sanitizedContext }];
  if (sanitizedScreenshot) {
    userContent.push({ type: 'image_url', image_url: { url: sanitizedScreenshot } });
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.2
    })
  });

  if (!res.ok) {
    throw new Error(`Remote reasoning call failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content;
  return parsePlan(raw);
}

function parsePlan(raw) {
  if (!raw) throw new Error('Empty remote response');
  let text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  const jsonSlice = first !== -1 && last !== -1 ? text.slice(first, last + 1) : text;
  const parsed = JSON.parse(jsonSlice);
  if (!Array.isArray(parsed.actions)) throw new Error('Remote plan missing actions[]');
  return parsed;
}
