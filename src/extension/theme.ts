import { EditorView } from "codemirror";

export const languageServerTheme = EditorView.theme({
    '.cm-tooltip': {
        'font-family': 'monospace'
    },
    '.cm-tooltip-section': {
        'padding': '0 1rem'
    }
})