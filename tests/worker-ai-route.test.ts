import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "@/worker/src/index";
import { streamProvider } from "@/worker/src/ai";
import type { Env } from "@/worker/src/env";
import type { AIRequest, ProviderSettings } from "@/shared/types";

const aiRequest: AIRequest = {
  prompt: "Hi",
  title: "Test note",
  bodyMarkdown: "",
};

const geminiSettings: ProviderSettings = {
  provider: "gemini",
  apiUrl: "https://generativelanguage.googleapis.test",
  apiKey: "test-key",
  model: "gemini-flash-latest",
  liveModel: "gemini-3.1-flash-live-preview",
  imageModel: "gemini-3.1-flash-image-preview",
  liveRecording: {
    echoCancellation: false,
    noiseSuppression: false,
    standbyEnabled: true,
  },
};

const unusedEnv = {
  DB: {},
  MEDIA_BUCKET: {},
} as unknown as Env;

function createEnvWithoutSavedSettings() {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
        }),
      }),
    },
    MEDIA_BUCKET: {},
  } as unknown as Env;
}

describe("Worker AI route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a JSON error when streamed chat setup fails", async () => {
    const response = await worker.fetch(
      new Request("https://worker.test/v1/ai/ask?stream=1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": "test-user",
        },
        body: JSON.stringify(aiRequest),
      }),
      createEnvWithoutSavedSettings(),
    );

    await expect(response.json()).resolves.toEqual({
      error: "Missing API key. Save provider settings first.",
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("falls back to a non-stream Gemini response when streaming is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(":streamGenerateContent")) {
        return new Response(
          JSON.stringify({
            error: {
              code: 503,
              message: "This model is currently experiencing high demand.",
              status: "UNAVAILABLE",
            },
          }),
          { status: 503, headers: { "content-type": "text/event-stream" } },
        );
      }

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "{\"answer\":\"ok\",\"substitutions\":[]}" }],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await streamProvider(unusedEnv, "test-user", geminiSettings, aiRequest);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: done");
    expect(body).toContain("\"answer\":\"ok\"");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
