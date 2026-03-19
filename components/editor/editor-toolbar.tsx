"use client";

import { Button } from "@/components/ui/button";
import type { EditorCommand } from "@/lib/editor/commands";

const commands: Array<{ label: string; command: EditorCommand }> = [
  { label: "Bold", command: "bold" },
  { label: "Italic", command: "italic" },
  { label: "Underline", command: "underline" },
  { label: "List", command: "insertUnorderedList" },
  { label: "H1", command: "formatBlock:h1" },
  { label: "H2", command: "formatBlock:h2" },
  { label: "Quote", command: "formatBlock:blockquote" },
];

export function EditorToolbar({ onCommand }: { onCommand: (command: EditorCommand) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {commands.map((item) => (
        <Button key={item.command} onClick={() => onCommand(item.command)} type="button">
          {item.label}
        </Button>
      ))}
    </div>
  );
}
