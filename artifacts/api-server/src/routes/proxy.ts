import { Router, type IRouter, type Request, type Response } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? "dummy",
});

const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? "dummy",
});

const OPENAI_MODELS = [
  { id: "gpt-5.2", provider: "openai" },
  { id: "gpt-5-mini", provider: "openai" },
  { id: "gpt-5-nano", provider: "openai" },
  { id: "o4-mini", provider: "openai" },
  { id: "o3", provider: "openai" },
];

const ANTHROPIC_MODELS = [
  { id: "claude-opus-4-6", provider: "anthropic" },
  { id: "claude-sonnet-4-6", provider: "anthropic" },
  { id: "claude-haiku-4-5", provider: "anthropic" },
];

const ALL_MODELS = [...OPENAI_MODELS, ...ANTHROPIC_MODELS];

function verifyBearer(req: Request, res: Response): boolean {
  const auth = req.headers["authorization"] ?? "";
  const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const xApiKey = (req.headers["x-api-key"] as string) ?? "";
  const token = bearerToken || xApiKey;
  if (!token || token !== process.env.PROXY_API_KEY) {
    res.status(401).json({ error: { message: "Unauthorized", type: "authentication_error" } });
    return false;
  }
  return true;
}

function isOpenAIModel(model: string): boolean {
  return model.startsWith("gpt-") || model.startsWith("o");
}

function isAnthropicModel(model: string): boolean {
  return model.startsWith("claude-");
}

type OpenAITool = OpenAI.Chat.Completions.ChatCompletionTool;
type AnthropicTool = Anthropic.Tool;
type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type AnthropicMessage = Anthropic.MessageParam;

function openAIToolsToAnthropic(tools: OpenAITool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
  }));
}

function openAIToolChoiceToAnthropic(
  choice: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption | undefined,
): Anthropic.ToolChoice | undefined {
  if (!choice) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.function) {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}

function openAIMessagesToAnthropic(
  messages: OpenAIMessage[],
): { system?: string; messages: AnthropicMessage[] } {
  let system: string | undefined;
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = typeof msg.content === "string" ? msg.content : "";
      continue;
    }

    if (msg.role === "tool") {
      const last = result[result.length - 1];
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content: typeof msg.content === "string" ? msg.content : "",
      };
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as Anthropic.ToolResultBlockParam[]).push(block);
      } else {
        result.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const contentBlocks: Anthropic.ContentBlock[] = [];
      if (typeof msg.content === "string" && msg.content) {
        contentBlocks.push({ type: "text", text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = {};
          }
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
      result.push({ role: "assistant", content: contentBlocks });
      continue;
    }

    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : "";
      result.push({ role: "user", content });
    }
  }

  return { system, messages: result };
}

function anthropicMessageToOpenAI(msg: Anthropic.Message): OpenAI.Chat.Completions.ChatCompletion {
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
  let text = "";

  for (const block of msg.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"] =
    msg.stop_reason === "tool_use" ? "tool_calls" : "stop";

  return {
    id: msg.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: msg.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          refusal: null,
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: msg.usage.input_tokens,
      completion_tokens: msg.usage.output_tokens,
      total_tokens: msg.usage.input_tokens + msg.usage.output_tokens,
    },
  };
}

router.get("/models", (req: Request, res: Response) => {
  if (!verifyBearer(req, res)) return;

  const now = Math.floor(Date.now() / 1000);
  res.json({
    object: "list",
    data: ALL_MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: now,
      owned_by: m.provider,
    })),
  });
});

router.post("/chat/completions", async (req: Request, res: Response) => {
  if (!verifyBearer(req, res)) return;

  const body = req.body as {
    model: string;
    messages: OpenAIMessage[];
    stream?: boolean;
    tools?: OpenAITool[];
    tool_choice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
    max_tokens?: number;
    temperature?: number;
    [key: string]: unknown;
  };

  const { model, messages, stream, tools, tool_choice, temperature, top_p, top_k, metadata, stop_sequences, thinking, ...restBody } = body;
  void restBody;

  if (!model) {
    res.status(400).json({ error: { message: "model is required", type: "invalid_request_error" } });
    return;
  }

  try {
    if (isOpenAIModel(model)) {
      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const keepalive = setInterval(() => {
          res.write(": keepalive\n\n");
        }, 5000);

        req.on("close", () => clearInterval(keepalive));

        try {
          const streamReq = await openai.chat.completions.create({
            ...body,
            stream: true,
          } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

          for await (const chunk of streamReq) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            (res as unknown as { flush?: () => void }).flush?.();
          }

          res.write("data: [DONE]\n\n");
          res.end();
        } finally {
          clearInterval(keepalive);
        }
      } else {
        const completion = await openai.chat.completions.create({
          ...body,
          stream: false,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
        res.json(completion);
      }
    } else if (isAnthropicModel(model)) {
      const { system, messages: anthropicMessages } = openAIMessagesToAnthropic(messages);
      const anthropicTools = tools ? openAIToolsToAnthropic(tools) : undefined;
      const anthropicToolChoice = openAIToolChoiceToAnthropic(tool_choice);
      const maxTokens = body.max_tokens ?? 8192;

      const anthropicParams: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        messages: anthropicMessages,
        ...(system ? { system } : {}),
        ...(anthropicTools ? { tools: anthropicTools } : {}),
        ...(anthropicToolChoice ? { tool_choice: anthropicToolChoice } : {}),
        ...(temperature !== undefined ? { temperature: temperature as number } : {}),
        ...(top_p !== undefined ? { top_p: top_p as number } : {}),
        ...(top_k !== undefined ? { top_k: top_k as number } : {}),
        ...(metadata !== undefined ? { metadata: metadata as Anthropic.MessageCreateParams["metadata"] } : {}),
        ...(stop_sequences !== undefined ? { stop_sequences: stop_sequences as string[] } : {}),
        ...(thinking !== undefined ? { thinking: thinking as Anthropic.ThinkingConfigParam } : {}),
      };

      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const keepalive = setInterval(() => {
          res.write(": keepalive\n\n");
        }, 5000);

        req.on("close", () => clearInterval(keepalive));

        try {
          const streamReq = anthropic.messages.stream({
            ...anthropicParams,
            stream: true,
          } as Anthropic.MessageStreamParams);

          let inputTokens = 0;
          let outputTokens = 0;
          let msgId = "";
          let stopReason: Anthropic.Message["stop_reason"] = "end_turn";

          streamReq.on("message", (msg) => {
            inputTokens = msg.usage.input_tokens;
            outputTokens = msg.usage.output_tokens;
            msgId = msg.id;
            stopReason = msg.stop_reason;
          });

          for await (const event of streamReq) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              const chunk: OpenAI.Chat.Completions.ChatCompletionChunk = {
                id: msgId || `msg_${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: event.delta.text },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              (res as unknown as { flush?: () => void }).flush?.();
            }
          }

          const finalChunk: OpenAI.Chat.Completions.ChatCompletionChunk = {
            id: msgId || `msg_${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: stopReason === "tool_use" ? "tool_calls" : "stop",
                logprobs: null,
              },
            ],
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            },
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } finally {
          clearInterval(keepalive);
        }
      } else {
        const msg = await anthropic.messages.create(anthropicParams);
        res.json(anthropicMessageToOpenAI(msg));
      }
    } else {
      res.status(400).json({
        error: { message: `Unknown model: ${model}. Supported models: ${ALL_MODELS.map((m) => m.id).join(", ")}`, type: "invalid_request_error" },
      });
    }
  } catch (err) {
    logger.error({ err }, "Proxy error in /chat/completions");
    if (!res.headersSent) {
      res.status(500).json({ error: { message: "Internal server error", type: "server_error" } });
    }
  }
});

router.post("/messages", async (req: Request, res: Response) => {
  if (!verifyBearer(req, res)) return;

  const body = req.body as Anthropic.MessageCreateParams & { stream?: boolean };
  const { model, stream } = body;

  if (!model) {
    res.status(400).json({ error: { message: "model is required", type: "invalid_request_error" } });
    return;
  }

  try {
    if (isAnthropicModel(model)) {
      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const keepalive = setInterval(() => {
          res.write(": keepalive\n\n");
        }, 5000);

        req.on("close", () => clearInterval(keepalive));

        try {
          const streamReq = anthropic.messages.stream(body as Anthropic.MessageStreamParams);

          for await (const event of streamReq) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            (res as unknown as { flush?: () => void }).flush?.();
          }

          res.end();
        } finally {
          clearInterval(keepalive);
        }
      } else {
        const msg = await anthropic.messages.create(body as Anthropic.MessageCreateParamsNonStreaming);
        res.json(msg);
      }
    } else if (isOpenAIModel(model)) {
      const openAIBody = body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams;
      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const keepalive = setInterval(() => {
          res.write(": keepalive\n\n");
        }, 5000);

        req.on("close", () => clearInterval(keepalive));

        try {
          const streamReq = await openai.chat.completions.create({
            ...openAIBody,
            stream: true,
          } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

          for await (const chunk of streamReq) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            (res as unknown as { flush?: () => void }).flush?.();
          }

          res.write("data: [DONE]\n\n");
          res.end();
        } finally {
          clearInterval(keepalive);
        }
      } else {
        const completion = await openai.chat.completions.create({
          ...openAIBody,
          stream: false,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
        res.json(completion);
      }
    } else {
      res.status(400).json({
        error: { message: `Unknown model: ${model}`, type: "invalid_request_error" },
      });
    }
  } catch (err) {
    logger.error({ err }, "Proxy error in /messages");
    if (!res.headersSent) {
      res.status(500).json({ error: { message: "Internal server error", type: "server_error" } });
    }
  }
});

export default router;
