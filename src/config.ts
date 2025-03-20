import { Facet } from "@codemirror/state";
import type { LanguageServerClient } from "./plugin.js";

// Feature toggle facets

export const diagnosticsEnabled = Facet.define<boolean, boolean>({
    combine: (values) => allTrue(values),
});

export const hoverEnabled = Facet.define<boolean, boolean>({
    combine: (values) => allTrue(values),
});

export const completionEnabled = Facet.define<boolean, boolean>({
    combine: (values) => allTrue(values),
});

export const definitionEnabled = Facet.define<boolean, boolean>({
    combine: (values) => allTrue(values),
});

export const renameEnabled = Facet.define<boolean, boolean>({
    combine: (values) => allTrue(values),
});

export const codeActionsEnabled = Facet.define<boolean, boolean>({
    combine: (values) => allTrue(values),
});

function allTrue(values: readonly boolean[]): boolean {
    // If no values are provided, default to true
    if (values.length === 0) {
        return true;
    }

    return values.every((value) => value);
}

export function createUseLastOrThrow(message: string) {
    return function useLastOrThrow<T>(values: readonly T[]): T {
        // if (values.length === 0) {
        //     throw new Error(message);
        // }
        // biome-ignore lint/style/noNonNullAssertion: <explanation>
        return values.at(-1)!;
    };
}

export const languageServerClient = Facet.define<
    LanguageServerClient,
    LanguageServerClient
>({
    combine: createUseLastOrThrow(
        "No language server client provided. Either pass a one into the extension or use languageServerClient.of().",
    ),
});

export const documentUri = Facet.define<string, string>({
    combine: createUseLastOrThrow(
        "No document URI provided. Either pass a one into the extension or use documentUri.of().",
    ),
});

export const languageId = Facet.define<string, string>({
    combine: createUseLastOrThrow(
        "No language ID provided. Either pass a one into the extension or use languageId.of().",
    ),
});
