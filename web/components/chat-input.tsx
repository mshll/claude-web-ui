import { useState, useRef, useCallback, useEffect } from "react";
import { Send, Square } from "lucide-react";

interface ChatInputProps {
  onSend: (message: string) => void;
  onInterrupt?: () => void;
  disabled?: boolean;
  isProcessing?: boolean;
  placeholder?: string;
}

export function ChatInput(props: ChatInputProps) {
  const {
    onSend,
    onInterrupt,
    disabled = false,
    isProcessing = false,
    placeholder = "Send a message...",
  } = props;

  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const maxHeight = 200;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;

    onSend(trimmed);
    setValue("");
  }, [value, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInterrupt = useCallback(() => {
    onInterrupt?.();
  }, [onInterrupt]);

  const canSend = value.trim().length > 0 && !disabled;
  const showInterrupt = isProcessing && onInterrupt;

  return (
    <div className="border-t border-zinc-800/60 bg-zinc-900/80 px-4 py-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-xl border border-zinc-700/50 bg-zinc-800/50 px-3 py-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none disabled:opacity-50"
          />
          {showInterrupt ? (
            <button
              type="button"
              onClick={handleInterrupt}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-rose-600 text-white transition-colors hover:bg-rose-500"
              title="Interrupt"
            >
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSend}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-cyan-600 text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-cyan-600"
              title="Send message"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[11px] text-zinc-600">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
