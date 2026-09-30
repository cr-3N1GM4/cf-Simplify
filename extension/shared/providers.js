/* AI providers the extension can use with a person's own key.
   All of them speak the OpenAI-compatible /chat/completions format.
   Keep the defaults in sync with builder/cfsimplify/config.py. */
(function (root) {
  'use strict';
  root.CFS_PROVIDERS = {
    gemini: {
      label: 'Google Gemini (free key)',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: 'gemini-flash-latest',
      needsKey: true,
      keyUrl: 'https://aistudio.google.com/apikey',
      keyHelp: 'Get a free key at aistudio.google.com/apikey (no card needed).',
      modelHelp: 'Leave empty for gemini-flash-latest. gemini-flash-lite-latest is faster and has higher free limits.'
    },
    groq: {
      label: 'Groq (free key)',
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: 'openai/gpt-oss-120b',
      needsKey: true,
      keyUrl: 'https://console.groq.com/keys',
      keyHelp: 'Get a free key at console.groq.com/keys.',
      modelHelp: 'Leave empty for openai/gpt-oss-120b.'
    },
    openrouter: {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: '',
      needsKey: true,
      keyUrl: 'https://openrouter.ai/keys',
      keyHelp: 'Get a key at openrouter.ai/keys.',
      modelHelp: 'Required. Models whose name ends in ":free" cost nothing.'
    },
    ollama: {
      label: 'Ollama (runs on your computer)',
      baseUrl: 'http://localhost:11434/v1',
      defaultModel: 'gemma3:12b',
      needsKey: false,
      editableBaseUrl: true,
      keyHelp: '',
      modelHelp: 'Any model you have pulled, for example gemma3:12b. Larger models follow the rules more reliably.'
    },
    custom: {
      label: 'Another OpenAI-compatible API',
      baseUrl: '',
      defaultModel: '',
      needsKey: false,
      editableBaseUrl: true,
      keyHelp: 'Leave empty if the service does not need a key.',
      modelHelp: 'Required.'
    }
  };
})(globalThis);
