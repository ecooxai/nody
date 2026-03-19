import type { AIRequest, AIResponse, ProviderSettings } from "../../shared/types";
import { safeJsonParse } from "../../shared/substitutions";

const systemPrompt =
  "You are a writing assistant. Reply with JSON: {\"answer\":\"...\",\"substitutions\":[{\"find\":\"...\",\"replace\":\"...\",\"all\":false}]}. Keep substitutions minimal and exact.";

export async function askProvider(settings: ProviderSettings, request: AIRequest): Promise<AIResponse> {
  if (!settings.apiKey) {
    throw new Error("Missing API key. Save provider settings first.");
  }
  return settings.provider === "gemini" ? askGemini(settings, request) : askOpenAI(settings, request);
}

async function askOpenAI(settings: ProviderSettings, request: AIRequest) {
  const response = await fetch(`${settings.apiUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.4,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Title: ${request.title}\n\nDocument HTML:\n${request.bodyHtml}\n\nSelection:\n${request.selection ?? ""}\n\nPrompt:\n${request.prompt}`,
        },
      ],
      response_format: { type: "json_object" },
    }),
  });
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return safeJsonParse<AIResponse>(data.choices?.[0]?.message?.content ?? "", { answer: "No answer", substitutions: [] });
}

async function askGemini(settings: ProviderSettings, request: AIRequest) {
  const base = settings.apiUrl.replace(/\/$/, "");
  const url = `${base}/v1beta/models/${settings.model}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Title: ${request.title}\n\nDocument HTML:\n${request.bodyHtml}\n\nSelection:\n${request.selection ?? ""}\n\nPrompt:\n${request.prompt}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json",
      },
    }),
  });
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return safeJsonParse<AIResponse>(text, { answer: "No answer", substitutions: [] });
}
