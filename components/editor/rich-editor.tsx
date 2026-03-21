"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent } from "react";

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
  editable: boolean;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onSelectionChange?: (selectedText: string) => void;
  onRequestEdit?: () => void;
  overlay?: React.ReactNode;
  topRight?: React.ReactNode;
};

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor({
  title,
  bodyHtml,
  editable,
  onTitleChange,
  onBodyChange,
  onSelectionChange,
  onRequestEdit,
  overlay,
  topRight,
}, ref) {
  const shellRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const [editButtonPosition, setEditButtonPosition] = useState<{ x: number; y: number } | null>(null);

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
        onSelectionChange("");
        return;
      }

      const range = selection.getRangeAt(0);
      const anchorNode = selection.anchorNode;
      if (!anchorNode || !editor.contains(anchorNode)) {
        onSelectionChange("");
        return;
      }

      const selectedText = selection.toString().trim();
      if (selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
        savedRangeRef.current = selection.getRangeAt(0).cloneRange();
      }
      if (!selectedText) {
        onSelectionChange("");
        return;
      }

      onSelectionChange(selectedText);
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [onSelectionChange]);

  useEffect(() => {
    if (!editable) return;
    setEditButtonPosition(null);
  }, [editable]);

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

  const showEditButton = (event: MouseEvent<HTMLElement>) => {
    if (editable) return;
    const shell = shellRef.current;
    if (!shell) return;

    const rect = shell.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - rect.left + 10, 16), rect.width - 52);
    const y = Math.min(Math.max(event.clientY - rect.top + 10, 16), rect.height - 52);
    setEditButtonPosition({ x, y });
  };

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (editable) {
        editorRef.current?.focus();
        return;
      }
      titleInputRef.current?.focus();
    },
    insertAsset: (asset, position = "cursor") => {
      const editor = editorRef.current;
      if (!editor || !editable) return;

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
      if (!editable) return;
      editorRef.current?.focus();
      handleCommand(command);
    },
  }), [editable, onBodyChange]);

  return (
    <div className="relative min-h-[calc(100vh-4rem)] bg-white/92 px-5 pb-16 pt-5 shadow-[0_12px_40px_rgba(15,23,42,0.06)] sm:px-7" ref={shellRef}>
      <div className="flex items-start justify-between gap-4">
        <input
          className={`min-w-0 w-full bg-transparent font-display text-3xl outline-none sm:text-4xl ${editable ? "" : "cursor-text"}`}
          onChange={(event) => onTitleChange(event.target.value)}
          onMouseUp={showEditButton}
          placeholder="Untitled note"
          readOnly={!editable}
          ref={titleInputRef}
          value={title}
        />
        {topRight ? <div className="flex shrink-0 items-center gap-2">{topRight}</div> : null}
      </div>
      {overlay ? <div className="mt-4">{overlay}</div> : null}
      <div
        className={`prose prose-stone mt-5 min-h-[34rem] max-w-none bg-transparent pb-6 outline-none ${editable ? "" : "cursor-text select-text"}`}
        contentEditable={editable}
        onInput={(event) => onBodyChange(event.currentTarget.innerHTML)}
        onMouseUp={showEditButton}
        ref={editorRef}
        suppressContentEditableWarning
      />
      {!editable && editButtonPosition ? (
        <button
          aria-label="Edit note"
          className="absolute z-20 flex h-11 w-11 items-center justify-center rounded-full border border-ink bg-ink text-white shadow-[0_12px_24px_rgba(15,23,42,0.16)] transition hover:bg-ink/90"
          onClick={() => onRequestEdit?.()}
          style={{ left: editButtonPosition.x, top: editButtonPosition.y }}
          title="Edit note"
          type="button"
        >
          <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
            <path
              d="M4 20h4l10-10-4-4L4 16v4Zm9-13l4 4"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
});

RichEditor.displayName = "RichEditor";
