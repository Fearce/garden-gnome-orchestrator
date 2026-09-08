// Let a `tsx` SSR gate import a real console component that imports its own stylesheet.
//
// Vite turns `import "./x.css"` into a style injection; plain Node has no such notion and dies with
// `ERR_UNKNOWN_FILE_EXTENSION` the moment a gate's import graph reaches one. That is a landmine rather
// than a rule: a component acquires a co-located sheet long after the gate that renders it was written,
// and the gate then fails for a reason that has nothing to do with what it asserts. (Paid for once —
// `CodeContextBar.tsx` gaining `codeContext.css` broke `test:cowork-ui`, which renders CoWork.)
//
// Import this FIRST, then reach the components through `await import(...)`:
//
//     import "./ssrCssStub.mjs";
//     const { CoWork } = await import("../src/components/CoWork.js");
//
// The dynamic import is not a style choice — `register()` only affects modules loaded after it runs,
// and a static component import is hoisted above it. The existing SSR gates already load their
// components that way for the classic-JSX-runtime reason, so this costs them nothing.
//
// Gates using it: `cowork-ui.test.tsx`. The other SSR gates (`themes`, `office-navigation`,
// `implementation-memos-ui`, `manual-deployment-ui`, `model-request-ui`) render components whose graphs
// hold no stylesheet yet — add the import there the moment one does.

import { register } from "node:module";

register("./ssrCssStubHooks.mjs", import.meta.url);
