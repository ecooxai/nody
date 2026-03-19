"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { insertHtml, runEditorCommand, type EditorCommand } from "@/lib/editor/commands";
import { assetToMarkup } from "@/lib/editor/media";
import type { DocumentAsset } from "@/shared/types";

export type RichEditorHandle = {
  focus: () => void;
  insertAsset: (asset: DocumentAsset, position?: "cursor" | "top") => void;
  runCommand: (command: EditorCommand) => void;
};

type RichEditorProps = {
  title: string;
  bodyHtml: string;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onSelectionChange?: (selectedText: string) => void;
  overlay?: React.ReactNode;
  topRight?: React.ReactNode;
};

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor({
  title,
  bodyHtml,
  onTitleChange,
  onBodyChange,
  onSelectionChange,
  overlay,
  topRight,
}, ref) {
  const editorRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);

  useEffect(() => {
    if (!editorRef.current) return;
    if (editorRef.current.innerHTML !== bodyHtml) {
      editorRef.current.innerHTML = bodyHtml;
    }
  }, [bodyHtml]);

  useEffect(() => {
    const handleSelectionChange = () => {
      if (!onSelectionChange) return;

      const editor = editorRef.current;
      const selection = window.getSelection();

      if (!editor || !selection || selection.rangeCount === 0) {
        return;
      }

      const range = selection.getRangeAt(0);
      const anchorNode = selection.anchorNode;
      if (!anchorNode || !editor.contains(anchorNode)) {
        return;
      }

      const selectedText = selection.toString().trim();
      if (selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
        savedRangeRef.current = selection.getRangeAt(0).cloneRange();
      }
      if (!selectedText) return;

      onSelectionChange(selectedText);
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [onSelectionChange]);

  const handleCommand = (command: EditorCommand) => {
    runEditorCommand(command);
    onBodyChange(editorRef.current?.innerHTML ?? "");
  };

  const restoreSavedRange = () => {
    const range = savedRangeRef.current;
    const editor = editorRef.current;
    if (!range || !editor) return false;

    const selection = window.getSelection();
    if (!selection) return false;

    selection.removeAllRanges();
    selection.addRange(range.cloneRange());
    editor.focus();
    return true;
  };

  useImperativeHandle(ref, () => ({
    focus: () => {
      editorRef.current?.focus();
    },
    insertAsset: (asset, position = "cursor") => {
      const editor = editorRef.current;
      if (!editor) return;

      const markup = assetToMarkup(asset);
      editor.focus();

      if (position === "top") {
        editor.insertAdjacentHTML("afterbegin", markup);
        onBodyChange(editor.innerHTML);
        return;
      }

      if (!restoreSavedRange()) {
        editor.insertAdjacentHTML("afterbegin", markup);
        onBodyChange(editor.innerHTML);
        return;
      }

      insertHtml(markup);
      onBodyChange(editorRef.current?.innerHTML ?? "");
    },
    runCommand: (command) => {
      editorRef.current?.focus();
      handleCommand(command);
    },
  }), [onBodyChange]);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-white/92 px-5 pb-16 pt-5 shadow-[0_12px_40px_rgba(15,23,42,0.06)] sm:px-7">
      <div className="flex items-start justify-between gap-4">
        <input
          className="min-w-0 w-full bg-transparent font-display text-3xl outline-none sm:text-4xl"
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="Untitled note"
          value={title}
        />
        {topRight ? <div className="flex shrink-0 items-center gap-2">{topRight}</div> : null}
      </div>
      {overlay ? <div className="mt-4">{overlay}</div> : null}
      <div
        className="prose prose-stone mt-5 min-h-[34rem] max-w-none bg-transparent pb-6 outline-none"
        contentEditable
        onInput={(event) => onBodyChange(event.currentTarget.innerHTML)}
        ref={editorRef}
        suppressContentEditableWarning
      />
    </div>
  );
});

RichEditor.displayName = "RichEditor";
