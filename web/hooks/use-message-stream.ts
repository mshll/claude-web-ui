import { useState, useCallback, useRef } from "react";
import type { ConversationMessage, ContentBlock } from "@claude-web-ui/api";

export interface StreamingMessage {
  id: string;
  type: "user" | "assistant";
  content: ContentBlock[];
  isStreaming: boolean;
}

export interface UseMessageStreamReturn {
  streamingMessages: StreamingMessage[];
  handleChunk: (chunk: unknown) => void;
  addUserMessage: (content: string) => void;
  clearStreamingMessages: () => void;
  isStreaming: boolean;
}

interface AssistantMessageEvent {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    content: ContentBlock[];
    model: string;
    stop_reason: string | null;
    stop_sequence: string | null;
  };
}

interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: ContentBlock;
}

interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: {
    type: "text_delta" | "thinking_delta" | "input_json_delta";
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
}

interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

interface MessageStopEvent {
  type: "message_stop";
}

interface ResultEvent {
  type: "result";
  subtype: "success" | "error";
  result?: string;
  error?: string;
}

type StreamEvent =
  | AssistantMessageEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageStopEvent
  | ResultEvent;

function deepCopyContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => ({ ...block }));
}

export function useMessageStream(): UseMessageStreamReturn {
  const [streamingMessages, setStreamingMessages] = useState<StreamingMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const bufferRef = useRef<string>("");
  const currentMessageIdRef = useRef<string | null>(null);
  const contentBlocksRef = useRef<ContentBlock[]>([]);
  const messageCounterRef = useRef(0);

  const processEvent = useCallback((event: StreamEvent) => {
    switch (event.type) {
      case "assistant": {
        const messageId = event.message.id || `stream-assistant-${++messageCounterRef.current}`;
        currentMessageIdRef.current = messageId;
        contentBlocksRef.current = event.message.content || [];
        setIsStreaming(true);

        setStreamingMessages((prev) => {
          const existingIndex = prev.findIndex((m) => m.id === messageId);
          if (existingIndex >= 0) {
            const updated = [...prev];
            updated[existingIndex] = {
              ...updated[existingIndex],
              content: deepCopyContentBlocks(contentBlocksRef.current),
              isStreaming: true,
            };
            return updated;
          }
          return [
            ...prev,
            {
              id: messageId,
              type: "assistant",
              content: deepCopyContentBlocks(contentBlocksRef.current),
              isStreaming: true,
            },
          ];
        });
        break;
      }

      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "tool_use") {
          contentBlocksRef.current[event.index] = {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          };
        } else if (block.type === "text") {
          contentBlocksRef.current[event.index] = {
            type: "text",
            text: block.text || "",
          };
        } else if (block.type === "thinking") {
          contentBlocksRef.current[event.index] = {
            type: "thinking",
            thinking: block.thinking || "",
          };
        }

        if (currentMessageIdRef.current) {
          setStreamingMessages((prev) =>
            prev.map((m) =>
              m.id === currentMessageIdRef.current
                ? { ...m, content: deepCopyContentBlocks(contentBlocksRef.current) }
                : m
            )
          );
        }
        break;
      }

      case "content_block_delta": {
        const block = contentBlocksRef.current[event.index];
        if (!block) return;

        if (event.delta.type === "text_delta" && event.delta.text) {
          if (block.type === "text") {
            block.text = (block.text || "") + event.delta.text;
          }
        } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
          if (block.type === "thinking") {
            block.thinking = (block.thinking || "") + event.delta.thinking;
          }
        } else if (event.delta.type === "input_json_delta" && event.delta.partial_json) {
          if (block.type === "tool_use") {
            const currentInput = typeof block.input === "string" ? block.input : "";
            block.input = currentInput + event.delta.partial_json;
          }
        }

        if (currentMessageIdRef.current) {
          setStreamingMessages((prev) =>
            prev.map((m) =>
              m.id === currentMessageIdRef.current
                ? { ...m, content: deepCopyContentBlocks(contentBlocksRef.current) }
                : m
            )
          );
        }
        break;
      }

      case "content_block_stop": {
        const block = contentBlocksRef.current[event.index];
        if (block?.type === "tool_use" && typeof block.input === "string") {
          try {
            block.input = JSON.parse(block.input);
          } catch {
            // Keep as string if parsing fails
          }
        }

        if (currentMessageIdRef.current) {
          setStreamingMessages((prev) =>
            prev.map((m) =>
              m.id === currentMessageIdRef.current
                ? { ...m, content: deepCopyContentBlocks(contentBlocksRef.current) }
                : m
            )
          );
        }
        break;
      }

      case "message_stop": {
        const messageId = currentMessageIdRef.current;
        if (messageId) {
          setStreamingMessages((prev) =>
            prev.map((m) =>
              m.id === messageId ? { ...m, isStreaming: false } : m
            )
          );
        }
        currentMessageIdRef.current = null;
        contentBlocksRef.current = [];
        break;
      }

      case "result": {
        setIsStreaming(false);
        currentMessageIdRef.current = null;
        contentBlocksRef.current = [];
        break;
      }
    }
  }, []);

  const handleChunk = useCallback(
    (chunk: unknown) => {
      if (typeof chunk !== "string") return;

      bufferRef.current += chunk;

      const lines = bufferRef.current.split("\n");
      bufferRef.current = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed) as StreamEvent;
          processEvent(event);
        } catch {
          // Skip non-JSON lines
        }
      }
    },
    [processEvent]
  );

  const addUserMessage = useCallback((content: string) => {
    const id = `stream-user-${++messageCounterRef.current}`;
    setStreamingMessages((prev) => [
      ...prev,
      {
        id,
        type: "user",
        content: [{ type: "text", text: content }],
        isStreaming: false,
      },
    ]);
  }, []);

  const clearStreamingMessages = useCallback(() => {
    setStreamingMessages([]);
    bufferRef.current = "";
    currentMessageIdRef.current = null;
    contentBlocksRef.current = [];
    messageCounterRef.current = 0;
    setIsStreaming(false);
  }, []);

  return {
    streamingMessages,
    handleChunk,
    addUserMessage,
    clearStreamingMessages,
    isStreaming,
  };
}

export function streamingToConversation(streaming: StreamingMessage): ConversationMessage {
  return {
    type: streaming.type,
    uuid: streaming.id,
    message: {
      role: streaming.type,
      content: streaming.content,
    },
  };
}
