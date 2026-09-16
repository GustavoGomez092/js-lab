export type PropKey = { k: string } | { sym: string };

export interface StackFrame {
  fn?: string;
  file?: string;
  line?: number;
  column?: number;
  user: boolean;
}

export type EncodedValue =
  | { t: "undefined" }
  | { t: "null" }
  | { t: "boolean"; v: boolean }
  | { t: "number"; v: string }
  | { t: "bigint"; v: string }
  | { t: "symbol"; desc: string }
  | { t: "string"; v: string; truncated?: { total: number; handle: string } }
  | {
      t: "function";
      name: string;
      kind: "function" | "arrow" | "async" | "generator" | "asyncGenerator" | "class" | "bound" | "native";
      handle: string;
    }
  | {
      t: "object";
      id: number;
      ctor: string | null;
      props: [PropKey, EncodedValue][];
      more?: number;
      proto?: EncodedValue;
      handle?: string;
      frozen?: boolean;
      proxy?: boolean;
    }
  | {
      t: "array";
      id: number;
      ctor: string;
      length: number;
      items: ([number, EncodedValue] | { hole: number })[];
      more?: number;
      handle?: string;
    }
  | { t: "map"; id: number; size: number; entries: [EncodedValue, EncodedValue][]; more?: number; handle?: string }
  | { t: "set"; id: number; size: number; items: EncodedValue[]; more?: number; handle?: string }
  | { t: "weak"; kind: "WeakMap" | "WeakSet" | "WeakRef" }
  | { t: "promise"; id: number; state: "pending" | "fulfilled" | "rejected"; value?: EncodedValue }
  | { t: "error"; name: string; message: string; stack: StackFrame[]; cause?: EncodedValue }
  | { t: "date"; iso: string | null }
  | { t: "regexp"; source: string; flags: string }
  | { t: "typedArray"; ctor: string; length: number; items: (number | string)[]; more?: number; handle?: string }
  | { t: "arrayBuffer"; byteLength: number; preview: number[] }
  | { t: "url"; href: string }
  | { t: "headers"; entries: [string, string][] }
  | { t: "response"; status: number; statusText: string; url: string; headers: [string, string][] }
  | {
      t: "dom";
      nodeType: number;
      tag: string;
      attrs: [string, string][];
      childCount: number;
      outerHTML: string;
      truncated?: { total: number; handle: string };
    }
  | { t: "getter"; handle: string }
  | { t: "circular"; ref: number }
  | { t: "handle"; handle: string; preview: string };
