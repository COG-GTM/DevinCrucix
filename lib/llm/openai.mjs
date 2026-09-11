// OpenAI Provider — raw fetch, no SDK

import { LLMProvider } from './provider.mjs';

export class OpenAIProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.name = 'openai';
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-5.4';
  }

  get isConfigured() { return !!this.apiKey; }
  get supportsVision() { return true; }

  async complete(systemPrompt, userMessage, opts = {}) {
    return this._chat(systemPrompt, userMessage, opts);
  }

  async completeVision(systemPrompt, userMessage, image, opts = {}) {
    const content = [
      { type: 'text', text: userMessage },
      { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } },
    ];
    return this._chat(systemPrompt, content, opts);
  }

  async _chat(systemPrompt, userContent, opts) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: opts.maxTokens || 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeout || 60000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`OpenAI API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';

    return {
      text,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      model: data.model || this.model,
    };
  }
}
