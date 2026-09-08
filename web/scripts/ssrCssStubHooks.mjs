// The module-customization half of `ssrCssStub.mjs` — see that file for why this exists.
//
// Registered ON TOP of tsx's own hooks, so this `load` is offered every URL first and defers
// everything that isn't a stylesheet back down the chain with `next`.

const STYLESHEET = /\.(?:css|scss|sass|less)(?:\?.*)?$/;

export async function load(url, context, next) {
  if (!STYLESHEET.test(url)) return next(url, context);
  // Vite hands a component the sheet's URL string; nothing rendered server-side reads it, so an empty
  // module is a faithful stand-in. Returning `undefined` here would fail the same way as no hook at all.
  return { format: "module", shortCircuit: true, source: "export default undefined;" };
}
