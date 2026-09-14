import type { Language, Settings } from "@jslab/shared";

export interface PrettierFormatOptions {
  parser: "typescript" | "babel-ts" | "babel";
  printWidth: number;
  tabWidth: number;
  useTabs: boolean;
  semi: boolean;
  singleQuote: boolean;
  quoteProps: "as-needed" | "consistent" | "preserve";
  jsxSingleQuote: boolean;
  trailingComma: "all" | "es5" | "none";
  bracketSpacing: boolean;
  bracketSameLine: boolean;
  arrowParens: "always" | "avoid";
}

export function prettierOptions(settings: Settings, language: Language): PrettierFormatOptions {
  const p = settings.prettier;
  return {
    parser: language === "typescript" ? "typescript" : language === "tsx" ? "babel-ts" : "babel",
    printWidth: p.printWidth,
    tabWidth: p.tabWidth,
    useTabs: p.useTabs,
    semi: p.semi,
    singleQuote: p.singleQuote,
    quoteProps: p.quoteProps,
    jsxSingleQuote: p.jsxSingleQuote,
    trailingComma: p.trailingComma,
    bracketSpacing: p.bracketSpacing,
    bracketSameLine: p.bracketSameLine,
    arrowParens: p.arrowParens,
  };
}
