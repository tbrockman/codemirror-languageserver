import { Transport } from "@open-rpc/client-js/build/transports/Transport.js";
import type LSP from "vscode-languageserver-protocol";
import { ServerCapabilities } from "vscode-languageserver-protocol";
import { LanguageServerPlugin } from "../extension/plugin.js";

export interface LanguageServerBaseOptions {
    rootUri: string;
    workspaceFolders: LSP.WorkspaceFolder[] | null;
    documentUri: string;
    languageId: string;
}

export interface LanguageServerClientOptions extends LanguageServerBaseOptions {
    transport: Transport;
    autoClose?: boolean;
    capabilities?:
    | LSP.InitializeParams["capabilities"]
    | ((
        defaultCapabilities: LSP.InitializeParams["capabilities"],
    ) => LSP.InitializeParams["capabilities"]);
    initializationOptions?: LSP.InitializeParams["initializationOptions"];
    timeout?: number;
}

export interface KeyboardShortcuts {
    rename?: string;
    goToDefinition?: string;
}

export interface DefinitionResult {
    uri: string;
    range: LSP.Range;
    isExternalDocument: boolean;
}

export interface LanguageServerClient {
    ready: boolean;
    capabilities: ServerCapabilities | null;
    initializePromise: Promise<void>;
    clientCapabilities: LanguageServerClientOptions["capabilities"];

    textDocumentDidOpen: (params: LSP.DidOpenTextDocumentParams) => Promise<LSP.DidOpenTextDocumentParams>;
    textDocumentDidChange: (params: LSP.DidChangeTextDocumentParams) => Promise<LSP.DidChangeTextDocumentParams>;
    textDocumentHover: (params: LSP.HoverParams) => Promise<LSP.Hover>;
    textDocumentCompletion: (params: LSP.CompletionParams) => Promise<LSP.CompletionItem[] | LSP.CompletionList | null>;
    completionItemResolve: (item: LSP.CompletionItem) => Promise<LSP.CompletionItem>;
    textDocumentDefinition: (params: LSP.DefinitionParams) => Promise<LSP.Definition | LSP.DefinitionLink[] | null>;
    textDocumentCodeAction: (params: LSP.CodeActionParams) => Promise<(LSP.Command | LSP.CodeAction)[] | null>;
    textDocumentRename: (params: LSP.RenameParams) => Promise<LSP.WorkspaceEdit | null>;
    textDocumentPrepareRename: (params: LSP.PrepareRenameParams) => Promise<LSP.Range | LSP.PrepareRenameResult | null>;

    close: () => void;
    attachPlugin: (plugin: LanguageServerPlugin) => void;
    detachPlugin: (plugin: LanguageServerPlugin) => void;
}

export interface LanguageServerOptions extends LanguageServerClientOptions {
    client?: LanguageServerClient;
    allowHTMLContent?: boolean;
    keyboardShortcuts?: KeyboardShortcuts;
    onGoToDefinition?: (result: DefinitionResult) => void;
}

export interface LanguageServerWebsocketOptions extends LanguageServerBaseOptions {
    serverUri: `ws://${string}` | `wss://${string}`;
}


// https://microsoft.github.io/language-server-protocol/specifications/specification-current/

// Client to server then server to client
export interface LSPRequestMap {
    initialize: [LSP.InitializeParams, LSP.InitializeResult];
    "textDocument/hover": [LSP.HoverParams, LSP.Hover];
    "textDocument/completion": [
        LSP.CompletionParams,
        LSP.CompletionItem[] | LSP.CompletionList | null,
    ];
    "completionItem/resolve": [LSP.CompletionItem, LSP.CompletionItem];
    "textDocument/definition": [
        LSP.DefinitionParams,
        LSP.Definition | LSP.DefinitionLink[] | null,
    ];
    "textDocument/codeAction": [
        LSP.CodeActionParams,
        (LSP.Command | LSP.CodeAction)[] | null,
    ];
    "textDocument/rename": [LSP.RenameParams, LSP.WorkspaceEdit | null];
    "textDocument/prepareRename": [
        LSP.PrepareRenameParams,
        LSP.Range | LSP.PrepareRenameResult | null,
    ];
}

// Client to server
export interface LSPNotifyMap {
    initialized: LSP.InitializedParams;
    "textDocument/didChange": LSP.DidChangeTextDocumentParams;
    "textDocument/didOpen": LSP.DidOpenTextDocumentParams;
}

// Server to client
export interface LSPEventMap {
    "textDocument/publishDiagnostics": LSP.PublishDiagnosticsParams;
}

export type Notification = {
    [key in keyof LSPEventMap]: {
        jsonrpc: "2.0";
        id?: null | undefined;
        method: key;
        params: LSPEventMap[key];
    };
}[keyof LSPEventMap];