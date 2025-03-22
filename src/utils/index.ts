import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { marked } from "marked";
import type * as LSP from "vscode-languageserver-protocol";

export function posToOffset(
    doc: Text,
    pos: { line: number; character: number },
): number | undefined {
    if (pos.line >= doc.lines) {
        return;
    }
    const offset = doc.line(pos.line + 1).from + pos.character;
    if (offset > doc.length) {
        return;
    }
    return offset;
}

export function posToOffsetOrZero(
    doc: Text,
    pos: { line: number; character: number },
): number {
    return posToOffset(doc, pos) || 0;
}

export function offsetToPos(doc: Text, offset: number) {
    const line = doc.lineAt(offset);
    return {
        character: offset - line.from,
        line: line.number - 1,
    };
}

export function formatContents(
    contents:
        | LSP.MarkupContent
        | LSP.MarkedString
        | LSP.MarkedString[]
        | undefined,
): string {
    if (!contents) {
        return "";
    }
    if (isLSPMarkupContent(contents)) {
        let value = contents.value;
        if (contents.kind === "markdown") {
            value = marked(value, { async: false });
        }
        return value;
    }
    if (Array.isArray(contents)) {
        return contents.map((c) => `${formatContents(c)}\n\n`).join("");
    }
    if (typeof contents === "string") {
        return contents;
    }
    return "";
}

export function toSet(chars: Set<string>) {
    let preamble = "";
    let flat = Array.from(chars).join("");
    const words = /\w/.test(flat);
    if (words) {
        preamble += "\\w";
        flat = flat.replace(/\w/g, "");
    }
    return `[${preamble}${flat.replace(/[^\w\s]/g, "\\$&")}]`;
}

export function prefixMatch(items: LSP.CompletionItem[]) {
    const first = new Set<string>();
    const rest = new Set<string>();

    for (const item of items) {
        const [initial, ...restStr] = item.textEdit?.newText || item.label;
        if (initial) {
            first.add(initial);
        }
        for (const char of restStr) {
            rest.add(char);
        }
    }

    const source = `${toSet(first) + toSet(rest)}*$`;
    return [new RegExp(`^${source}`), new RegExp(source)];
}

export function isLSPTextEdit(
    textEdit?: LSP.TextEdit | LSP.InsertReplaceEdit,
): textEdit is LSP.TextEdit {
    return (textEdit as LSP.TextEdit)?.range !== undefined;
}

export function isLSPMarkupContent(
    contents: LSP.MarkupContent | LSP.MarkedString | LSP.MarkedString[],
): contents is LSP.MarkupContent {
    return (contents as LSP.MarkupContent).kind !== undefined;
}

export function showErrorMessage(view: EditorView, message: string) {
    const tooltip = document.createElement("div");
    tooltip.className = "cm-error-message";
    tooltip.style.cssText = `
  position: absolute;
  padding: 8px;
  background: #fee;
  border: 1px solid #fcc;
  border-radius: 4px;
  color: #c00;
  font-size: 14px;
  z-index: 100;
  max-width: 300px;
  box-shadow: 0 2px 8px rgba(0,0,0,.15);
`;
    tooltip.textContent = message;

    // Position near the cursor
    const cursor = view.coordsAtPos(view.state.selection.main.head);
    if (cursor) {
        tooltip.style.left = `${cursor.left}px`;
        tooltip.style.top = `${cursor.bottom + 5}px`;
    }

    document.body.appendChild(tooltip);

    // Remove after 3 seconds
    setTimeout(() => {
        tooltip.style.opacity = "0";
        tooltip.style.transition = "opacity 0.2s";
        setTimeout(() => tooltip.remove(), 200);
    }, 3000);
}
