/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMessageStream, streamingToConversation } from "./use-message-stream";

describe("useMessageStream", () => {
  describe("initial state", () => {
    it("starts with empty streaming messages", () => {
      const { result } = renderHook(() => useMessageStream());
      expect(result.current.streamingMessages).toEqual([]);
    });

    it("starts with isStreaming false", () => {
      const { result } = renderHook(() => useMessageStream());
      expect(result.current.isStreaming).toBe(false);
    });
  });

  describe("addUserMessage", () => {
    it("adds a user message to streaming messages", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.addUserMessage("Hello world");
      });

      expect(result.current.streamingMessages).toHaveLength(1);
      expect(result.current.streamingMessages[0]).toMatchObject({
        type: "user",
        content: [{ type: "text", text: "Hello world" }],
        isStreaming: false,
      });
    });

    it("assigns unique ids to user messages", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.addUserMessage("First");
        result.current.addUserMessage("Second");
      });

      const ids = result.current.streamingMessages.map((m) => m.id);
      expect(ids[0]).not.toBe(ids[1]);
    });
  });

  describe("handleChunk - assistant message events", () => {
    it("creates an assistant message on assistant event", () => {
      const { result } = renderHook(() => useMessageStream());

      const assistantEvent = JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-123",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-opus",
          stop_reason: null,
          stop_sequence: null,
        },
      });

      act(() => {
        result.current.handleChunk(assistantEvent + "\n");
      });

      expect(result.current.streamingMessages).toHaveLength(1);
      expect(result.current.streamingMessages[0]).toMatchObject({
        id: "msg-123",
        type: "assistant",
        isStreaming: true,
      });
      expect(result.current.isStreaming).toBe(true);
    });

    it("handles assistant event with initial content", () => {
      const { result } = renderHook(() => useMessageStream());

      const assistantEvent = JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-123",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          model: "claude-3-opus",
          stop_reason: null,
          stop_sequence: null,
        },
      });

      act(() => {
        result.current.handleChunk(assistantEvent + "\n");
      });

      expect(result.current.streamingMessages[0].content).toEqual([
        { type: "text", text: "Hello" },
      ]);
    });
  });

  describe("handleChunk - content block events", () => {
    it("handles content_block_start for text", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk(
          JSON.stringify({
            type: "assistant",
            message: { id: "msg-1", content: [] },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }) + "\n"
        );
      });

      expect(result.current.streamingMessages[0].content[0]).toMatchObject({
        type: "text",
        text: "",
      });
    });

    it("handles content_block_delta for text", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk(
          JSON.stringify({
            type: "assistant",
            message: { id: "msg-1", content: [] },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello " },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "world!" },
          }) + "\n"
        );
      });

      expect(result.current.streamingMessages[0].content[0]).toMatchObject({
        type: "text",
        text: "Hello world!",
      });
    });

    it("handles content_block_start for tool_use", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk(
          JSON.stringify({
            type: "assistant",
            message: { id: "msg-1", content: [] },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
            },
          }) + "\n"
        );
      });

      expect(result.current.streamingMessages[0].content[0]).toMatchObject({
        type: "tool_use",
        id: "tool-1",
        name: "Read",
        input: {},
      });
    });

    it("handles content_block_delta for tool input JSON", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk(
          JSON.stringify({
            type: "assistant",
            message: { id: "msg-1", content: [] },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tool-1", name: "Read" },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"file_' },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: 'path":"test.ts"}' },
          }) + "\n"
        );
      });

      expect(result.current.streamingMessages[0].content[0]).toMatchObject({
        type: "tool_use",
        input: '{"file_path":"test.ts"}',
      });
    });

    it("parses tool input JSON on content_block_stop", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk(
          JSON.stringify({
            type: "assistant",
            message: { id: "msg-1", content: [] },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tool-1", name: "Read" },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"file_path":"test.ts"}' },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_stop",
            index: 0,
          }) + "\n"
        );
      });

      expect(result.current.streamingMessages[0].content[0]).toMatchObject({
        type: "tool_use",
        input: { file_path: "test.ts" },
      });
    });

    it("handles content_block_start for thinking", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk(
          JSON.stringify({
            type: "assistant",
            message: { id: "msg-1", content: [] },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          }) + "\n"
        );
      });

      expect(result.current.streamingMessages[0].content[0]).toMatchObject({
        type: "thinking",
        thinking: "",
      });
    });

    it("handles content_block_delta for thinking", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk(
          JSON.stringify({
            type: "assistant",
            message: { id: "msg-1", content: [] },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          }) + "\n"
        );
        result.current.handleChunk(
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Let me think..." },
          }) + "\n"
        );
      });

      expect(result.current.streamingMessages[0].content[0]).toMatchObject({
        type: "thinking",
        thinking: "Let me think...",
      });
    });
  });

  describe("handleChunk - message completion events", () => {
    it("sets isStreaming false on message_stop", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk(
          JSON.stringify({
            type: "assistant",
            message: { id: "msg-1", content: [] },
          }) + "\n"
        );
      });

      expect(result.current.streamingMessages[0].isStreaming).toBe(true);

      act(() => {
        result.current.handleChunk(
          JSON.stringify({ type: "message_stop" }) + "\n"
        );
      });

      expect(result.current.streamingMessages[0].isStreaming).toBe(false);
    });

    it("sets isStreaming false on result event", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk(
          JSON.stringify({
            type: "assistant",
            message: { id: "msg-1", content: [] },
          }) + "\n"
        );
      });

      expect(result.current.isStreaming).toBe(true);

      act(() => {
        result.current.handleChunk(
          JSON.stringify({ type: "result", subtype: "success" }) + "\n"
        );
      });

      expect(result.current.isStreaming).toBe(false);
    });
  });

  describe("handleChunk - buffering", () => {
    it("buffers partial lines", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk('{"type":"assistant","message":{"id":"msg-1"');
      });

      expect(result.current.streamingMessages).toHaveLength(0);

      act(() => {
        result.current.handleChunk(',"content":[]}}\n');
      });

      expect(result.current.streamingMessages).toHaveLength(1);
    });

    it("processes multiple lines in one chunk", () => {
      const { result } = renderHook(() => useMessageStream());

      const multiLine =
        JSON.stringify({ type: "assistant", message: { id: "msg-1", content: [] } }) +
        "\n" +
        JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "Hi" } }) +
        "\n";

      act(() => {
        result.current.handleChunk(multiLine);
      });

      expect(result.current.streamingMessages).toHaveLength(1);
      expect(result.current.streamingMessages[0].content[0]).toMatchObject({
        type: "text",
        text: "Hi",
      });
    });

    it("skips invalid JSON lines", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk("not json\n");
        result.current.handleChunk(
          JSON.stringify({ type: "assistant", message: { id: "msg-1", content: [] } }) + "\n"
        );
      });

      expect(result.current.streamingMessages).toHaveLength(1);
    });

    it("ignores non-string chunks", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk(123);
        result.current.handleChunk(null);
        result.current.handleChunk(undefined);
        result.current.handleChunk({ type: "object" });
      });

      expect(result.current.streamingMessages).toHaveLength(0);
    });
  });

  describe("clearStreamingMessages", () => {
    it("clears all streaming messages", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.addUserMessage("Hello");
        result.current.handleChunk(
          JSON.stringify({ type: "assistant", message: { id: "msg-1", content: [] } }) + "\n"
        );
      });

      expect(result.current.streamingMessages).toHaveLength(2);

      act(() => {
        result.current.clearStreamingMessages();
      });

      expect(result.current.streamingMessages).toHaveLength(0);
      expect(result.current.isStreaming).toBe(false);
    });
  });

  describe("multiple assistant messages", () => {
    it("handles multiple assistant messages in sequence", () => {
      const { result } = renderHook(() => useMessageStream());

      act(() => {
        result.current.handleChunk(
          JSON.stringify({ type: "assistant", message: { id: "msg-1", content: [] } }) + "\n"
        );
      });
      act(() => {
        result.current.handleChunk(
          JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + "\n"
        );
      });
      act(() => {
        result.current.handleChunk(
          JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "First" } }) + "\n"
        );
      });
      act(() => {
        result.current.handleChunk(
          JSON.stringify({ type: "message_stop" }) + "\n"
        );
      });
      act(() => {
        result.current.handleChunk(
          JSON.stringify({ type: "assistant", message: { id: "msg-2", content: [] } }) + "\n"
        );
      });
      act(() => {
        result.current.handleChunk(
          JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + "\n"
        );
      });
      act(() => {
        result.current.handleChunk(
          JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Second" } }) + "\n"
        );
      });

      expect(result.current.streamingMessages).toHaveLength(2);
      expect(result.current.streamingMessages[0].content[0]).toMatchObject({
        type: "text",
        text: "First",
      });
      expect(result.current.streamingMessages[1].content[0]).toMatchObject({
        type: "text",
        text: "Second",
      });
    });
  });
});

describe("streamingToConversation", () => {
  it("converts user streaming message to conversation message", () => {
    const streaming = {
      id: "user-1",
      type: "user" as const,
      content: [{ type: "text" as const, text: "Hello" }],
      isStreaming: false,
    };

    const result = streamingToConversation(streaming);

    expect(result).toEqual({
      type: "user",
      uuid: "user-1",
      message: {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    });
  });

  it("converts assistant streaming message to conversation message", () => {
    const streaming = {
      id: "assistant-1",
      type: "assistant" as const,
      content: [
        { type: "text" as const, text: "Hello" },
        { type: "tool_use" as const, id: "t1", name: "Read", input: {} },
      ],
      isStreaming: true,
    };

    const result = streamingToConversation(streaming);

    expect(result).toEqual({
      type: "assistant",
      uuid: "assistant-1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
      },
    });
  });
});
