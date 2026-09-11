// Base LLM Provider — all providers implement this interface

export class LLMProvider {
  constructor(config) {
    this.config = config;
    this.name = 'base';
  }

  /**
   * Complete a prompt with system + user messages
   * @returns {{ text: string, usage: { inputTokens: number, outputTokens: number }, model: string }}
   */
  async complete(systemPrompt, userMessage, opts = {}) {
    throw new Error(`${this.name}: complete() not implemented`);
  }

  get isConfigured() { return false; }

  // Providers that can look at an image override this and completeVision().
  get supportsVision() { return false; }

  /**
   * Complete a prompt about one image.
   * @param {{ mime: string, base64: string }} image
   * @returns {{ text: string, usage: { inputTokens: number, outputTokens: number }, model: string }}
   */
  async completeVision(systemPrompt, userMessage, image, opts = {}) {
    throw new Error(`${this.name}: completeVision() not supported`);
  }
}
