import { useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { CodeHeaderProps } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

function CodeHeader({ language, code }: CodeHeaderProps) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="chat-code-header">
      <span>{language || "代码"}</span>
      <button type="button" onClick={() => void copy()} aria-label={copied ? "已复制代码" : "复制代码"} title={copied ? "已复制" : "复制代码"}>
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}{copied ? "已复制" : "复制代码"}
      </button>
    </div>
  );
}

/** Official assistant-ui markdown renderer with GitHub-flavoured tables/lists. */
export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className="chat-markdown"
      remarkPlugins={[remarkGfm]}
      components={{ CodeHeader }}
      skipHtml
      smooth
      defer
    />
  );
}
