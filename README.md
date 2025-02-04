# CodeMirror 6 Language Server Protocol (LSP) Plugin

[![npm version](https://badge.fury.io/js/@marimo-team/codemirror-languageserver.svg)](https://www.npmjs.com/package/@marimo-team/codemirror-languageserver)

A powerful LSP client plugin for CodeMirror 6 that brings IDE-like features to your editor.

## Features

- 🔍 **Code Completion** - Intelligent autocompletion with support for snippets
- 💡 **Hover Information** - Rich documentation on hover
- ⚠️ **Diagnostics** - Real-time error checking and warnings
- 🔄 **Code Actions** - Quick fixes and refactoring suggestions
- 🏷️ **Symbol Renaming** - Smart symbol renaming across files
- 🎯 **Go to Definition** - Jump to symbol definitions
- 🎨 **Markdown Support** - Rich formatting in hover tooltips and documentation

## Installation

```bash
npm install @marimo-team/codemirror-languageserver
# or
pnpm add @marimo-team/codemirror-languageserver
# or
yarn add @marimo-team/codemirror-languageserver
```

## Usage

```typescript
import { languageServer } from '@marimo-team/codemirror-languageserver';
import { EditorState, EditorView } from '@codemirror/basic-setup';
import { WebSocketTransport } from '@open-rpc/client-js';

// Create a WebSocket transport
const transport = new WebSocketTransport('ws://your-language-server-url');

// Configure the language server plugin
const ls = languageServer({
  transport,
  rootUri: 'file:///',
  documentUri: 'file:///path/to/your/file',
  languageId: 'typescript', // Or any other language ID supported by your LSP

  // Optional: Customize keyboard shortcuts
  keyboardShortcuts: {
    rename: 'F2',                // Default: F2
    goToDefinition: 'ctrlcmd',   // Ctrl/Cmd + Click
  },

  // Optional: Allow HTML content in tooltips
  allowHTMLContent: true,
});

// Create editor with the LSP plugin
const view = new EditorView({
  state: EditorState.create({
    doc: 'Your initial content',
    extensions: [
      // ... other extensions ...
      ls
    ]
  }),
  parent: document.querySelector('#editor')
});
```

## Keyboard Shortcuts

- `F2` - Rename symbol under cursor
- `Ctrl/Cmd + Click` - Go to definition
- `Ctrl/Cmd + Space` - Trigger completion manually

## Advanced Configuration

### Sharing Client Across Multiple Instances

```typescript
import { LanguageServerClient } from '@marimo-team/codemirror-languageserver';

const client = new LanguageServerClient({
  transport,
  rootUri: 'file:///',
  workspaceFolders: [{ name: 'workspace', uri: 'file:///' }]
});

// Use in multiple editors
const ls1 = languageServer({
  client,
  documentUri: 'file:///file1.ts',
  languageId: 'typescript'
});

const ls2 = languageServer({
  client,
  documentUri: 'file:///file2.ts',
  languageId: 'typescript'
});
```

## Contributing

Contributions are welcome! Feel free to:

- Report bugs
- Suggest new features
- Submit pull requests

Please ensure your PR includes appropriate tests and documentation.

## Demo

Check out our [live demo](https://github.com/mscolnick/codemirror-languageserver/tree/main/demo) to see the plugin in action.

## License

BSD 3-Clause License

## Credits

This is a modernized fork of [FurqanSoftware/codemirror-languageserver](https://github.com/FurqanSoftware/codemirror-languageserver) with additional features:

- Modernized codebase (linting, formatting, etc.)
- Testing
- GitHub Actions CI
- Symbol renaming
- Code actions and quick fixes
- Go-to-definition
- Improved demo page
- Better error handling
- Enhanced documentation
