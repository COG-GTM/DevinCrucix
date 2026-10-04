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
  get supportsWebSearch() { return true; }

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

  // Responses API with the hosted web_search tool; returns the message text plus the URL citations OpenAI attached.
  async completeWithWebSearch(systemPrompt, userMessage, opts = {}) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        instructions: systemPrompt,
        input: userMessage,
        tools: [{ type: 'web_search_preview' }],
        tool_choice: 'auto',
        max_output_tokens: opts.maxTokens || 1024,
      }),
      signal: AbortSignal.timeout(opts.timeout || 60000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`OpenAI Responses API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    let text = '';
    const sources = [];
    let searched = false;
    for (const item of data.output || []) {
      if (item.type === 'web_search_call') searched = true;
      if (item.type !== 'message') continue;
      for (const c of item.content || []) {
        if (c.type !== 'output_text') continue;
        text += (text ? '\n' : '') + (c.text || '');
        for (const a of c.annotations || []) if (a.type === 'url_citation' && a.url) sources.push({ title: a.title || '', url: a.url });
      }
    }
    if (!text && typeof data.output_text === 'string') text = data.output_text;

    return {
      text,
      sources,
      searched,
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      },
      model: data.model || this.model,
    };
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
